# AI Support Chat - deploy checklist

1. Run `sql/add-support-chat.sql` against your Supabase database
   (creates `support_topics`, `support_sessions`, `support_messages`,
   `support_escalations`, and seeds a starter set of rule-based topics).

2. In Back4App's environment variables for the backend, add:

   ```
   GEMINI_API_KEY=AIzaSy...
   GROQ_API_KEY=...
   CEREBRAS_API_KEY=...
   OPENROUTER_API_KEY=...
   ```

   Double-check the Gemini key specifically starts with `AIzaSy` (a real
   Gemini API key from Google AI Studio) - a different-shaped key (e.g.
   an OAuth token) will fail every Gemini call and just fall through to
   Groq every time.

3. Redeploy. On startup you should see two new log lines:
   - `[cron] Support call rating-reminder job scheduled (every minute, ~12min delay).`
   - the new `/api/support-chat` routes are mounted automatically in `server.js`.

4. Nothing else to configure - the rule-based tier, fallback chain,
   category menu, escalation detection, analytics, and rating flow are
   all plain backend code reading from the four keys above. Existing
   web-push subscriptions (already set up for other notifications) are
   reused for the Section 9.2 backup rating reminder.

5. In the frontend, the chat bubble is already mounted on every portal
   (tenant, landlord/manager/caretaker, admin) - no separate frontend
   env vars needed.
