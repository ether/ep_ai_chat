'use strict';

const extractMention = (text, trigger) => {
  const escapedTrigger = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedTrigger, 'gi');
  if (!regex.test(text)) return {mentioned: false, query: ''};
  const query = text.replace(new RegExp(escapedTrigger, 'gi'), '').trim();
  return {mentioned: true, query};
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
