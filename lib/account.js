// Account deletion — GDPR-compliant, irreversible.
//
// What happens:
//   1. Pinecone: delete the tenant's namespace (drops all vectors).
//   2. Supabase: delete the tenant row. ON DELETE CASCADE wired in the
//      tenants migration cascades through users → knowledge / schema_types /
//      sources / mcp_tokens / magic_tokens. The audit_log table has NO foreign
//      key on user_id, so the deletion-event records survive.
//   3. Audit event is written before AND after — so we have both intent and
//      outcome on record even if the Supabase delete partially fails.
//
// What we do NOT do:
//   * Log any of the deleted content. Audit records are { user_id, tenant_id,
//     event_type, outcome } — never the knowledge/messages/etc.
//   * Cascade-delete audit history. That's the legal-hold trail.

import { getDB } from './supabase.js';
import { getNamespace } from './pinecone.js';
import { logAudit } from './audit.js';

export async function deleteAccount({ userId }) {
  const db = getDB();

  // Resolve tenant_id for this user (also confirms the user exists)
  const { data: user, error: userErr } = await db
    .from('users')
    .select('id, tenant_id')
    .eq('id', userId)
    .maybeSingle();
  if (userErr || !user) throw new Error('User not found');
  const tenantId = user.tenant_id;

  // Audit: started — before any destructive op so we have proof of intent
  logAudit({ userId, tenantId, eventType: 'account_deletion_started' });

  // Pinecone — best effort. If it fails, we still proceed with the DB delete;
  // orphan vectors in a deleted-tenant namespace are harmless (no row to
  // join against) and a future cleanup pass can drop them.
  let pineconeDeleted = false;
  let pineconeError   = null;
  try {
    await getNamespace(tenantId).deleteAll();
    pineconeDeleted = true;
  } catch (err) {
    pineconeError = err?.message || String(err);
    console.error('[delete-account] Pinecone deleteAll failed:', pineconeError);
  }

  // Supabase — cascade through tenants → users → everything else (except audit_log).
  const { error: delErr } = await db.from('tenants').delete().eq('id', tenantId);
  if (delErr) {
    logAudit({ userId, tenantId, eventType: 'account_deletion_completed', success: false, errorType: 'SupabaseDeleteFailed', errorMsg: delErr.message, context: { pinecone_deleted: pineconeDeleted } });
    throw new Error(`Supabase delete failed: ${delErr.message}`);
  }

  // Audit: completed
  logAudit({
    userId,
    tenantId,
    eventType: 'account_deletion_completed',
    success:   true,
    context:   { pinecone_deleted: pineconeDeleted, pinecone_error: pineconeError },
  });

  return { tenantId, pineconeDeleted, pineconeError };
}
