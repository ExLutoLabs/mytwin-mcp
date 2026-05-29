// lib/inngest.js — Inngest client singleton.
// Import this in any file that needs to send or define Inngest events/functions.

import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'myaitwin' });
