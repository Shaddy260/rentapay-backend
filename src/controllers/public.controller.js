// src/controllers/public.controller.js
//
// FEATURE (direct request): a fully open, free, no-login public
// listings page. Anyone can browse vacant units by county,
// constituency, or location with zero auth. Uses the same "only ever
// show status = 'vacant'" hard-lock pattern used elsewhere, for the
// same reason: this is a public, unauthenticated surface, so the
// occupancy status filter has to be enforced server-side, not left to
// the frontend to apply correctly.
//
// Contact is WhatsApp-only and resolved server-side per unit:
// property manager first, then caretaker, then the landlord
// themself - the raw number is never included in the bulk listings
// payload, only handed out (as a ready-to-open wa.me link) via the
// dedicated /contact endpoint when someone actually taps "Contact on
// WhatsApp" on a specific unit.
const supabase = require('../config/supabase');

function toWhatsAppLink(number, unitName) {
  if (!number) return null;
  const digits = number.replace(/[^\d]/g, '');
  const text = encodeURIComponent(`Hi, I'm interested in the vacant unit "${unitName}" I saw on RentaPay.`);
  return `https://wa.me/${digits}?text=${text}`;
}

// ---------------------------------------------------------------------
// GET /api/public/listings?county=&constituency=&location=&type=
// No auth. Vacant units only, hard-filtered server-side.
// ---------------------------------------------------------------------
async function listVacantUnits(req, res) {
  try {
    const { county, constituency, location, type } = req.query;

    let query = supabase
      .from('units')
      .select('id, unit_name, unit_type, rent_amount, photo_urls, property_id, landlord_id, properties(name, county, constituency, location)')
      .eq('status', 'vacant')
      .order('created_at', { ascending: false })
      .limit(300);

    if (type) query = query.eq('unit_type', type);

    const { data, error } = await query;
    if (error) throw error;

    let units = data || [];
    // county/constituency/location live on `properties`, not `units`
    // directly (units with no property_id are ungrouped and have no
    // location at all - excluded from a location-filtered search,
    // since there's nothing to match against).
    if (county) units = units.filter((u) => u.properties?.county?.toLowerCase() === county.toLowerCase());
    if (constituency) units = units.filter((u) => u.properties?.constituency?.toLowerCase() === constituency.toLowerCase());
    if (location) units = units.filter((u) => u.properties?.location?.toLowerCase().includes(location.toLowerCase()));

    const listings = units.map((u) => ({
      unitId: u.id,
      unitName: u.unit_name,
      unitType: u.unit_type,
      rentAmount: u.rent_amount,
      photoUrls: u.photo_urls || [],
      estateName: u.properties?.name || null,
      county: u.properties?.county || null,
      constituency: u.properties?.constituency || null,
      location: u.properties?.location || null,
    }));

    return res.json({ listings });
  } catch (err) {
    console.error('[public] listVacantUnits error:', err.message);
    return res.status(500).json({ error: 'Failed to load listings.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/listings/counties
// Distinct county/constituency values actually in use right now, so
// the search page's dropdowns only ever show places with real
// vacancies instead of a static list of all 47 counties.
// ---------------------------------------------------------------------
async function listSearchableAreas(req, res) {
  try {
    const { data, error } = await supabase
      .from('units')
      .select('properties(county, constituency)')
      .eq('status', 'vacant');
    if (error) throw error;

    const counties = new Map(); // county -> Set(constituencies)
    for (const u of data || []) {
      const county = u.properties?.county;
      if (!county) continue;
      if (!counties.has(county)) counties.set(county, new Set());
      if (u.properties?.constituency) counties.get(county).add(u.properties.constituency);
    }

    const areas = Array.from(counties.entries())
      .map(([county, constituencies]) => ({ county, constituencies: Array.from(constituencies).sort() }))
      .sort((a, b) => a.county.localeCompare(b.county));

    return res.json({ areas });
  } catch (err) {
    console.error('[public] listSearchableAreas error:', err.message);
    return res.status(500).json({ error: 'Failed to load areas.' });
  }
}

// ---------------------------------------------------------------------
// GET /api/public/listings/:unitId/contact
// Resolves the WhatsApp number to contact for this specific unit -
// manager assigned to the property, else caretaker, else the
// landlord themself - and hands back a ready-to-open wa.me link.
// Never returns the raw number as a separate field.
// ---------------------------------------------------------------------
async function getUnitContact(req, res) {
  try {
    const { unitId } = req.params;

    const { data: unit, error: unitErr } = await supabase
      .from('units')
      .select('id, unit_name, status, property_id, landlord_id, properties(caretaker_phone)')
      .eq('id', unitId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit || unit.status !== 'vacant') return res.status(404).json({ error: 'This unit is no longer available.' });

    let whatsappNumber = null;

    if (unit.property_id) {
      const { data: managers, error: mErr } = await supabase
        .from('property_managers')
        .select('id, whatsapp_number, role_level, created_at, property_manager_assignments(property_id)')
        .eq('landlord_id', unit.landlord_id)
        .eq('is_active', true);
      if (mErr) throw mErr;

      // A manager/caretaker with no assignment rows covers every
      // property for that landlord (same convention already used in
      // propertyManager.controller.js's updateManager peer-edit check).
      const coversThisProperty = (m) =>
        !m.property_manager_assignments?.length || m.property_manager_assignments.some((a) => a.property_id === unit.property_id);

      const pickBest = (roleLevel) =>
        (managers || [])
          .filter((m) => m.role_level === roleLevel && m.whatsapp_number && coversThisProperty(m))
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];

      whatsappNumber = pickBest('manager')?.whatsapp_number || pickBest('caretaker')?.whatsapp_number || null;
    }

    if (!whatsappNumber) whatsappNumber = unit.properties?.caretaker_phone || null;

    if (!whatsappNumber) {
      const { data: landlord } = await supabase.from('landlords').select('whatsapp_number').eq('id', unit.landlord_id).maybeSingle();
      whatsappNumber = landlord?.whatsapp_number || null;
    }

    const whatsappLink = toWhatsAppLink(whatsappNumber, unit.unit_name);
    if (!whatsappLink) return res.status(404).json({ error: 'No contact number is available for this unit yet.' });

    return res.json({ whatsappLink });
  } catch (err) {
    console.error('[public] getUnitContact error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve contact details.' });
  }
}

module.exports = { listVacantUnits, listSearchableAreas, getUnitContact };
