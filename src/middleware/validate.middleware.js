// src/middleware/validate.middleware.js
//
// Phase 2 - shared request validation. Attach to a route with:
//
//   router.post('/login', validate(loginSchema), authController.login);
//
// On failure it answers 400 with ONE consistent shape everywhere:
//
//   { error: 'Please fix the highlighted fields.', fields: { fieldName: 'message' } }
//
// `fields` lets the frontend map backend errors straight onto form
// inputs (the API client already surfaces the full body as `err.raw`).

const { ZodError } = require('zod');

function validate(schema, { source = 'body' } = {}) {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] || {});
    if (result.success) {
      // Keep Zod's coercions/transforms (e.g. '' -> undefined) visible
      // to the controller.
      if (source === 'body') req.body = result.data;
      return next();
    }

    const fields = {};
    if (result.error instanceof ZodError) {
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_error';
        if (!fields[key]) fields[key] = issue.message;
      }
    }

    // `error` stays human-readable for callers that only surface
    // err.message (login, register, change-password forms); `fields`
    // carries the per-input map for callers that render inline errors.
    const messages = Object.values(fields);
    const error =
      messages.length <= 1
        ? (messages[0] || 'Please check the submitted details.')
        : `Please fix the highlighted fields: ${messages.join(' ')}`;

    return res.status(400).json({ error, fields });
  };
}

module.exports = { validate };
