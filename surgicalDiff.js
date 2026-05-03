'use strict';

/**
 * Word-level diff used to make AI edits surgical at the changeset level.
 *
 * When the AI returns a {findText, replaceText} pair, applying it as a
 * single splice means every character of replaceText becomes AI-authored
 * — even words that already existed verbatim in findText (so were never
 * actually rewritten by the AI). Diffing the two strings first and only
 * inserting the genuinely-new runs preserves the original author's
 * attribution on the unchanged spans.
 *
 * The diff is word-and-whitespace tokenised: tokens are runs of either
 * non-space chars or whitespace. That gives clean breakpoints — a one-
 * word change doesn't accidentally re-author the surrounding words just
 * because a different mid-word substring happens to LCS-match.
 *
 * Returns a list of {type, text} ops where type is 'keep' | 'remove' |
 * 'insert'. Adjacent same-type ops are coalesced so the caller can map
 * each op directly to a single Changeset.Builder operation.
 */

const tokenize = (s) => s.match(/\S+|\s+/g) || [];

const lcsTable = (a, b) => {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({length: m + 1}, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp;
};

/**
 * Diff `oldText` -> `newText` and return the minimal sequence of
 * keep/remove/insert ops at the token level (whitespace-aware).
 */
const diffOps = (oldText, newText) => {
    if (oldText === newText) {
        return oldText.length ? [{type: 'keep', text: oldText}] : [];
    }
    const a = tokenize(oldText);
    const b = tokenize(newText);
    const dp = lcsTable(a, b);
    const ops = [];
    let i = a.length;
    let j = b.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            ops.unshift({type: 'keep', text: a[i - 1]});
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.unshift({type: 'insert', text: b[j - 1]});
            j--;
        } else {
            ops.unshift({type: 'remove', text: a[i - 1]});
            i--;
        }
    }
    // Coalesce adjacent same-type ops so the caller can emit one
    // Builder operation per chunk instead of one per token.
    const coalesced = [];
    for (const op of ops) {
        const last = coalesced[coalesced.length - 1];
        if (last && last.type === op.type) last.text += op.text;
        else coalesced.push({...op});
    }
    return coalesced;
};

const countNewlines = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
};

exports.tokenize = tokenize;
exports.diffOps = diffOps;
exports.countNewlines = countNewlines;
