// src/controllers/expense.controller.js
//
// Property-level expense tracking (repairs, utilities, staff, etc.),
// so PDF collection summaries can show real net profit instead of
// collections alone. Ownership is enforced with the same
// landlord/manager-property checks hardened elsewhere in the app
// (see auth.middleware.js: checkLandlordOwnership, checkManagerPropertyAccess).

const supabase = require('../config/supabase');
const {
  effectiveLandlordId,
  checkManagerPropertyAccess,
  requireNotCaretaker: _requireNotCaretaker, // exported from routes, not used here
} = require('../middleware/auth.middleware');
const { logActivity } = require('../services/activityLog.service');

const ALLOWED_CATEGORIES = ['Repairs', 'Utilities', 'Staff', 'Insurance', 'Taxes', 'Supplies', 'Other'];
const BUCKET_NAME = 'expense-receipts';

// LANDLORD/MANAGER: list expenses for a property (or every property
// they manage, if none specified).
async function listExpenses(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, from, to, category } = req.query;

    if (propertyId) {
      const accessError = await checkManagerPropertyAccess(req, propertyId);
      if (accessError) return res.status(accessError.statusCode).json(accessError);
    }

    let query = supabase.from('expenses').select('*, properties(name)').eq('landlord_id', landlordId).order('date', { ascending: false });
    if (propertyId) query = query.eq('property_id', propertyId);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);
    if (category) query = query.eq('category', category);

    const { data: expenses, error } = await query;
    if (error) throw error;

    return res.json({ expenses: expenses || [] });
  } catch (err) {
    console.error('[expense] listExpenses error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch expenses.' });
  }
}

// LANDLORD/MANAGER: log a new expense.
async function createExpense(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, category, amount, date, note } = req.body;

    if (!propertyId) return res.status(400).json({ error: 'propertyId is required.' });
    if (!category || !ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}.` });
    }
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number.' });

    // Confirm this property actually belongs to this landlord (not
    // just "some property the caller can name the id of").
    const { data: property, error: propertyError } = await supabase.from('properties').select('id, landlord_id').eq('id', propertyId).maybeSingle();
    if (propertyError) throw propertyError;
    if (!property || property.landlord_id !== landlordId) {
      return res.status(403).json({ error: 'You do not manage this property.' });
    }
    const accessError = await checkManagerPropertyAccess(req, propertyId);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    let receiptPhotoUrl = null;
    if (req.file) {
      const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : req.file.mimetype === 'application/pdf' ? 'pdf' : 'jpg';
      const path = `${landlordId}/${propertyId}/${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (uploadError) {
        if (/bucket not found/i.test(uploadError.message)) {
          return res.status(500).json({ error: 'Receipt storage isn\'t set up yet. In Supabase: Storage -> New bucket -> name it "expense-receipts" -> make it public.' });
        }
        throw uploadError;
      }
      const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
      receiptPhotoUrl = publicUrlData.publicUrl;
    }

    const { data: expense, error } = await supabase
      .from('expenses')
      .insert({
        landlord_id: landlordId,
        property_id: propertyId,
        category,
        amount: Number(amount),
        date: date || new Date().toISOString().slice(0, 10),
        note: note || null,
        receipt_photo_url: receiptPhotoUrl,
        created_by_type: req.user.role,
        created_by_id: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'expense_created', targetType: 'expense', targetId: expense.id, metadata: { landlordId, propertyId, category, amount: Number(amount) } });

    return res.status(201).json({ message: 'Expense recorded.', expense });
  } catch (err) {
    console.error('[expense] createExpense error:', err.message);
    return res.status(500).json({ error: 'Failed to record expense.' });
  }
}

// LANDLORD/MANAGER: edit an existing expense's category/amount/date/note.
async function updateExpense(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { expenseId } = req.params;
    const { category, amount, date, note } = req.body;

    const { data: existing, error: fetchError } = await supabase.from('expenses').select('id, landlord_id, property_id').eq('id', expenseId).maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'Expense not found.' });
    if (existing.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this expense.' });
    const accessError = await checkManagerPropertyAccess(req, existing.property_id);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    if (category && !ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}.` });
    }
    if (amount !== undefined && Number(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number.' });

    const updates = { updated_at: new Date().toISOString() };
    if (category) updates.category = category;
    if (amount !== undefined) updates.amount = Number(amount);
    if (date) updates.date = date;
    if (note !== undefined) updates.note = note || null;

    const { data: updated, error } = await supabase.from('expenses').update(updates).eq('id', expenseId).select().single();
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'expense_updated', targetType: 'expense', targetId: expenseId, metadata: { ...updates, landlordId, propertyId: existing.property_id } });

    return res.json({ message: 'Expense updated.', expense: updated });
  } catch (err) {
    console.error('[expense] updateExpense error:', err.message);
    return res.status(500).json({ error: 'Failed to update expense.' });
  }
}

// LANDLORD/MANAGER: delete an expense.
async function deleteExpense(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { expenseId } = req.params;

    const { data: existing, error: fetchError } = await supabase.from('expenses').select('id, landlord_id, property_id, category, amount, date').eq('id', expenseId).maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'Expense not found.' });
    if (existing.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this expense.' });
    const accessError = await checkManagerPropertyAccess(req, existing.property_id);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const { error } = await supabase.from('expenses').delete().eq('id', expenseId);
    if (error) throw error;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'expense_deleted',
      targetType: 'expense',
      targetId: expenseId,
      metadata: { landlordId, propertyId: existing.property_id, category: existing.category, amount: Number(existing.amount), date: existing.date },
    });

    return res.json({ message: 'Expense deleted.' });
  } catch (err) {
    console.error('[expense] deleteExpense error:', err.message);
    return res.status(500).json({ error: 'Failed to delete expense.' });
  }
}

module.exports = { listExpenses, createExpense, updateExpense, deleteExpense, ALLOWED_CATEGORIES };
