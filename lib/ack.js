// Generate a warm, contextual acknowledgement via Sonnet whenever the user
// commits a storage action. Spec §3.2 + §3.4: no robotic "Kept." or "Stored
// as 10 chunks". The ack is the bot's chat-thread reply and should sound
// like a thoughtful collaborator, in voice.
//
// Quality awareness:
//   * strong  — substantive content with good tags + title
//   * thin    — short, single sentence, weak tags
//   * typical — middle ground
//
// The Sonnet call sees: type, title, total count of that type after this
// store, the user's current stage, and the quality bucket. It returns one
// to two short sentences. We do NOT stream this — it's tiny and arrives in
// one shot as the response to /confirm-store or /document.

import { callTwin, responseText } from './anthropic.js';

const ACK_INSTRUCTION = [
  'You are the twin acknowledging that a user just stored something. The user is in their /twin chat, has just confirmed a propose-clarify-confirm-store flow, and the storage just happened. Reply with ONE OR TWO short sentences acknowledging it in voice. This is the bot turn in the conversation — it appears right after the proposal card.',
  '',
  'CRITICAL RULES:',
  '* Never use the word "chunks". Say "pieces", "sections", or "blocks" if you need to refer to extracted parts.',
  '* Never use one-word robotic openers like "Kept.", "Stored.", "Done.", "Acknowledged.", "Saved." alone.',
  '* You CAN start with "In.", "Got it.", "Filed.", "Caught.", "That\'s in." — but always follow with something contextual.',
  '* If first item of this type → frame as a beginning ("First one in your twin", "That\'s your first principle in here").',
  '* If 3+ items of this type → note the pattern building ("That\'s three principles now. Your thinking on this is building.").',
  '* If quality=strong → honest recognition ("That\'ll come back well.", "Solid one.", "That one\'s sharp.").',
  '* If quality=thin → kind nudge ("Worth keeping but stronger with an example. Want to add one?").',
  '* Optionally end with an invitational question if it fits naturally ("What\'s next?", "Anything to add?").',
  '',
  'STYLE:',
  '* Maximum 2 short sentences. Often 1 is enough.',
  '* No em dashes or en dashes. Use full stops or commas.',
  '* No markdown formatting.',
  '* No banned words: unlock, master, transformative, leverage, seamless, comprehensive, holistic, empower, supercharge.',
  '* The Luto voice. Warm + competent. Not gushing. Not flat.',
].join('\n');

/**
 * Generate an acknowledgement for a just-completed storage action.
 *
 * @param {object} ctx
 * @param {string} ctx.type            — knowledge | skill | idea | principle | reflection | document | voice-note
 * @param {string} [ctx.title]         — proposed/confirmed title
 * @param {number} [ctx.totalAfter]    — count of this type after the store
 * @param {'strong'|'thin'|'typical'} [ctx.quality]
 * @param {string} [ctx.stage]         — user stage (brave-beginner, etc.)
 * @param {number} [ctx.extractedItems] — for documents/voice notes: how many pieces were extracted
 * @returns {Promise<string>}
 */
export async function generateAck({ type, title, totalAfter, quality = 'typical', stage = 'comfortable', extractedItems = 0 }) {
  const lines = [
    `STORAGE EVENT:`,
    `- type: ${type}`,
    title ? `- title: "${title}"` : '',
    typeof totalAfter === 'number' ? `- total of this type now: ${totalAfter}` : '',
    `- quality: ${quality}`,
    `- user stage: ${stage}`,
    extractedItems > 0 ? `- extracted ${extractedItems} pieces from the source` : '',
    '',
    'Acknowledge this storage in 1-2 short sentences. In voice.',
  ].filter(Boolean).join('\n');

  try {
    const msg = await callTwin({
      messages: [{ role: 'user', content: lines }],
      maxTokens: 120,
      effort: 'low',
      extraSystem: ACK_INSTRUCTION,
    });
    return responseText(msg).trim();
  } catch (err) {
    console.warn('[ack] generation failed, falling back to template:', err?.message);
    // Tiny fallback. Still better than "Kept."
    const t = String(type || 'item').toLowerCase();
    return totalAfter === 1
      ? `In. First ${t} in your twin${title ? ` — about ${title}` : ''}.`
      : `Got it. Filed${title ? ` as ${t}: ${title}` : ` as ${t}`}. What's next?`;
  }
}
