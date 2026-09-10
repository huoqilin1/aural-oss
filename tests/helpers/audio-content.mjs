// Aperiodic signal avoids ambiguous correlation peaks from a single tone.
export function makeSignal(question) {
  let seed=question+173, previous=0, filtered=0;
  return Array.from({length:16000*8+question*160},()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    previous=previous*0.9+(seed/4294967296-0.5)*0.1;
    filtered=filtered*0.8+previous*0.2;
    return filtered;
  });
}
export function verifyAudioContent(expected,actual) {
  const correlation=(start,length,lag,stride=4)=>{
    let dot=0,a2=0,b2=0;
    for(let i=start;i<start+length;i+=stride){const a=expected[i]||0,b=actual[i+lag]||0;dot+=a*b;a2+=a*a;b2+=b*b;}
    return dot/Math.sqrt(a2*b2||1);
  };
  let anchor=-1,offset=0;
  for(let lag=0;lag<=8192;lag++){const score=correlation(48000,1024,lag);if(score>anchor){anchor=score;offset=lag;}}
  let unmatched=0,maxGap=0,gap=0,minLag=offset,maxLag=offset;
  // Bound clock alignment to 16 ms around one fixed anchor, never freely
  // realign whole seconds. A dropped 4096-sample transport packet must fail.
  for(let start=0;start<expected.length;start+=128){let best=-1,lagAt=offset;
    for(let lag=Math.max(0,offset-256);lag<=offset+256;lag++){const score=correlation(start,Math.min(128,expected.length-start),lag);if(score>best){best=score;lagAt=lag;}}
    if(best<0.97){const length=Math.min(128,expected.length-start);unmatched+=length;gap+=length;maxGap=Math.max(maxGap,gap);}else{gap=0;minLag=Math.min(minLag,lagAt);maxLag=Math.max(maxLag,lagAt);}
  }
  return {passed:anchor>0.97&&unmatched<=1024&&maxGap<=512,anchor,offset,unmatchedSamples:unmatched,maxGapSamples:maxGap,alignmentRangeSamples:maxLag-minLag};
}
