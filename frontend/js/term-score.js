// Counts belong to one explicitly identified term; never borrow another term's requirement.
const count = value => {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
export function pickTerm(terms) {
  if (!Array.isArray(terms)) return null;
  return terms.find(t => Number(t?.term_info?.is_this_term ?? t?.score_info?.is_this_term) === 1) || terms[0] || null;
}
export function normalizeTermScore(term, detail, requirements) {
  const id = String(term?.term_info?.term_id || term?.score_info?.term_id || term?.term_id || '');
  const score = { ...(term?.score_info || {}), ...(detail || {}) };
  const sameTerm = id !== '' && id === String(requirements?.term_id ?? '');
  score.completedCount = count(score.total_score_num ?? score.num);
  score.requiredCount = sameTerm ? count(requirements.term_num) : null;
  score.remainingCount = score.requiredCount != null && score.completedCount != null
    ? Math.max(0, score.requiredCount - score.completedCount) : null;
  return score;
}
