export function chooseSpeech(state) {
  if (!state.ready || state.terminal || state.error || state.playing || state.q < 1 || state.q > 8) return null;
  if (!state.mainSent) return {kind:'main',file:`${state.index}-${state.q}`};
  if (state.seq <= state.lastHandledSeq) return null;
  if (state.q === 8 && /还有.*(?:问题|想问)|有什么.*(?:问题|想问)|想了解|提问环节/.test(state.prompt)) return {kind:'finish',file:'finish'};
  if (/这(?:道)?题.*答完|(?:是否|已经|你).*回答完|Are you done/i.test(state.prompt)) return {kind:'done',file:'done'};
  if (state.supplements === 0) return {kind:'supplement',file:`${state.index}-${state.q}-supp`};
  return {kind:'no-more',file:'no-more'};
}
