type SearchableOnDemandTool = {
  name: string;
  displayName?: string | null;
  description?: string | null;
  applicationDisplayName?: string | null;
  applicationKey?: string | null;
  upstreamToolName?: string | null;
};

function searchTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Search only the caller-provided authorized set; preserve its order for an empty query. */
export function searchOnDemandTools<T extends SearchableOnDemandTool>(
  tools: readonly T[],
  query: string,
  limit: number,
): T[] {
  const terms = [...new Set(searchTokens(query))];
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  if (terms.length === 0) return tools.slice(0, boundedLimit);

  const fields = (tool: T) => [
    [tool.name, 8],
    [tool.displayName, 7],
    [tool.applicationDisplayName, 6],
    [tool.upstreamToolName, 5],
    [tool.applicationKey, 4],
    [tool.description, 1],
  ] as const;

  return tools
    .map((tool, index) => {
      const searchable = fields(tool).map(([value, weight]) => ({
        tokens: searchTokens(typeof value === "string" ? value : ""),
        weight,
      }));
      const termScores = terms.map((term) => Math.max(0, ...searchable.flatMap((field) => {
        const exact = field.tokens.includes(term);
        const partial = !exact && field.tokens.some((token) => token.includes(term));
        return exact ? [field.weight] : partial ? [Math.max(1, field.weight - 1)] : [];
      })));
      const matchedTerms = termScores.filter((score) => score > 0).length;
      return { tool, index, matchedTerms, score: termScores.reduce((sum, score) => sum + score, 0) };
    })
    .filter((result) => result.matchedTerms > 0)
    .sort((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score || a.index - b.index)
    .slice(0, boundedLimit)
    .map(({ tool }) => tool);
}
