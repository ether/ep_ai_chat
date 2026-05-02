'use strict';

const OVERRIDE_RE = /^\s*(apply|suggest)\s*:\s*([\s\S]*)$/i;

const extractMention = (text, trigger) => {
  const escapedTrigger = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const triggerRe = new RegExp(escapedTrigger, 'gi');
  if (!triggerRe.test(text)) return {mentioned: false, query: '', override: null};
  const remainder = text.replace(new RegExp(escapedTrigger, 'gi'), '').trim();
  const overrideMatch = remainder.match(OVERRIDE_RE);
  if (overrideMatch) {
    return {
      mentioned: true,
      override: overrideMatch[1].toLowerCase(),
      query: overrideMatch[2].trim(),
    };
  }
  return {mentioned: true, query: remainder, override: null};
};

const detectEditIntent = (query) => {
  const editPatterns = [
    /\b(rewrite|reword|rephrase|revise)\b/i,
    /\b(add|insert|append|prepend)\b.*\b(to|at|before|after)\b/i,
    /\b(replace|change|update|fix|correct)\b.*\b(with|to)\b/i,
    /\b(delete|remove)\b.*\b(paragraph|section|line|sentence|word)\b/i,
    /\b(write|draft|create)\b.*\b(paragraph|section|summary|introduction|conclusion)\b/i,
  ];
  return editPatterns.some((pattern) => pattern.test(query));
};

exports.extractMention = extractMention;
exports.detectEditIntent = detectEditIntent;
