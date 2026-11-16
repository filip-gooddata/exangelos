// Serialized into the page. Only the returned aggregate crosses the browser boundary.
export function createProbe() {
  let previous;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const fingerprint = async value => {
    const bytes = new TextEncoder().encode(value);
    const input = new Uint8Array(salt.length + bytes.length);
    input.set(salt); input.set(bytes, salt.length);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), b => b.toString(16).padStart(2, '0')).join('');
  };
  return async () => {
    const out = {
      probe_ok: false, slack_origin: false, bounded: true,
      root_count: 0, kit_rows: 0, qa_rows: 0, identity_rows: 0, body_rows: 0,
      timestamp_rows: 0, scoped_rows: 0, candidate_rows: 0,
      comparison_ready: false, retained_rows: 0, added_rows: 0,
      candidate_comparison: false, complete_snapshot: false,
      body_changes: 0, reaction_additions: 0, reaction_missing: 0,
      missing_rows: 0, removed_rows: 0,
    };
    const reset = () => { previous = undefined; return out; };
    const fail = () => {
      previous = undefined;
      for (const key of Object.keys(out)) out[key] = typeof out[key] === 'boolean' ? false : 0;
      return out;
    };
    try {
      out.slack_origin = location.origin === 'https://app.slack.com';
      if (!out.slack_origin) { return reset(); }
      const roots = [];
      const discovery = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
      let node = discovery.currentNode;
      let discovered = 0;
      while (node) {
        if (++discovered > 20000) return fail();
        if (node.matches('.p-threads_flexpane, [data-qa="threads_flexpane"]')) {
          roots.push(node);
          if (roots.length > 1) { out.root_count = 2; return reset(); }
        }
        node = discovery.nextNode();
      }
      out.root_count = roots.length;
      if (roots.length !== 1) return reset();
      const rows = [];
      const walker = document.createTreeWalker(roots[0], NodeFilter.SHOW_ELEMENT);
      let element = walker.currentNode;
      let count = 0;
      while (element) {
        if (++count > 20000) return fail();
        if (element.matches('.c-message_kit__message, [data-qa="message_container"]')) {
          rows.push(element);
          if (rows.length > 200) return fail();
        }
        element = walker.nextNode();
      }
      for (const row of rows) {
        if (row.matches('.c-message_kit__message')) out.kit_rows++;
        if (row.matches('[data-qa="message_container"]')) out.qa_rows++;
        let body = false;
        let timestamp = false;
        const fields = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT);
        let field = fields.currentNode;
        let visited = 0;
        while (field) {
          if (++visited > 500) return fail();
          if (field !== row && field.matches('.c-message_kit__message, [data-qa="message_container"]')) return fail();
          body ||= field.matches('.c-message_kit__text, [data-qa="message-text"]');
          timestamp ||= field.matches('[data-qa="message_timestamp"], .c-timestamp');
          field = fields.nextNode();
        }
        if (body) out.body_rows++;
        if (timestamp) out.timestamp_rows++;
        // Fixture-only capability hypotheses: presence, never attribute values.
        if (row.hasAttribute('data-message-id')) out.identity_rows++;
        if (row.closest('[data-channel-id]')) out.scoped_rows++;
      }
      out.candidate_rows = rows.length;
      // All selectors below are unverified candidates, never normalized events.
      const boundedValue = value => {
        if (typeof value !== 'string' || !value.trim() || value.length > 16384) throw null;
        return value;
      };
      const text = element => {
        let value = '';
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
        let node = walker.currentNode;
        let visited = 0;
        while (node) {
          if (++visited > 1000) throw null;
          if (node.nodeType === Node.ELEMENT_NODE && (node.isContentEditable || node.matches('input, textarea, select, script, style'))) throw null;
          if (node.nodeType === Node.TEXT_NODE) {
            value += node.nodeValue;
            if (value.length > 16384) throw null;
          }
          node = walker.nextNode();
        }
        return value;
      };
      const scopeNode = roots[0].closest('[data-channel-id]');
      const scopeValue = scopeNode?.getAttribute('data-channel-id');
      const anchor = rows[0]?.getAttribute('data-message-id');
      if (!scopeValue || !anchor || !rows.length) { out.probe_ok = true; return reset(); }
      const scopeInput = JSON.stringify([boundedValue(scopeValue), boundedValue(anchor)]);
      const captured = new Map();
      for (const row of rows) {
        const identity = row.getAttribute('data-message-id');
        const bodies = row.querySelectorAll('.c-message_kit__text, [data-qa="message-text"]');
        if (!identity || bodies.length !== 1) { out.probe_ok = true; return reset(); }
        const id = boundedValue(identity);
        if (captured.has(id)) return fail();
        const reactions = new Set();
        const reactionNodes = row.querySelectorAll('[data-qa="reaction"]');
        if (reactionNodes.length > 50) return fail();
        for (const reaction of reactionNodes) {
          const name = reaction.getAttribute('data-emoji-name');
          const count = reaction.getAttribute('data-count');
          if (!name || !count || !/^[1-9][0-9]{0,5}$/.test(count)) return fail();
          const key = JSON.stringify([boundedValue(name), count]);
          if (reactions.has(key)) return fail();
          reactions.add(key);
        }
        captured.set(id, { body: text(bodies[0]), reactions });
      }
      const scope = await fingerprint(scopeInput);
      const current = new Map();
      for (const [id, value] of captured) {
        current.set(await fingerprint(id), {
          body: await fingerprint(value.body),
          reactions: new Set(await Promise.all([...value.reactions].map(fingerprint))),
        });
      }
      // Root continuity and first-row anchor are conservative candidate guards,
      // not proof of workspace/account/thread identity or snapshot completeness.
      if (previous?.root === roots[0] && previous.scope === scope) {
        out.candidate_comparison = true;
        for (const [id, value] of current) {
          const old = previous.rows.get(id);
          if (!old) { out.added_rows++; continue; }
          out.retained_rows++;
          if (old.body !== value.body) out.body_changes++;
          if ([...value.reactions].some(key => !old.reactions.has(key))) out.reaction_additions++;
          if ([...old.reactions].some(key => !value.reactions.has(key))) out.reaction_missing++;
        }
        for (const id of previous.rows.keys()) if (!current.has(id)) out.missing_rows++;
      }
      previous = { root: roots[0], scope, rows: current };
      out.probe_ok = true;
      return out;
    } catch { return fail(); }
  };
}

export const booleanFields = ['probe_ok', 'slack_origin', 'bounded', 'comparison_ready', 'candidate_comparison', 'complete_snapshot'];
export const countFields = ['root_count', 'kit_rows', 'qa_rows', 'identity_rows', 'body_rows', 'timestamp_rows', 'scoped_rows', 'candidate_rows', 'retained_rows', 'added_rows', 'body_changes', 'reaction_additions', 'reaction_missing', 'missing_rows', 'removed_rows'];
export function sanitizeAggregate(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== booleanFields.length + countFields.length) return null;
  const clean = {};
  for (const key of booleanFields) {
    if (typeof value[key] !== 'boolean') return null;
    clean[key] = value[key];
  }
  for (const key of countFields) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 200) return null;
    clean[key] = value[key];
  }
  return clean;
}
