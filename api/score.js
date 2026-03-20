// api/score.js — TopScreen Scoring Pipeline v3
// Layer 1: Structured extraction (Groq)
// Layer 2: Rule-based deterministic scoring
// Layer 3: Groq validation + output generation
// Layer 4: Save to Supabase

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GROQ_KEY     = process.env.GROQ_API_KEY;
  const SUPA_URL     = process.env.SUPABASE_URL;
  const SUPA_KEY     = process.env.SUPABASE_ANON_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });

  const { cv_text, role, cohort, applicant, job } = req.body || {};
  if (!cv_text || !role || !cohort) return res.status(400).json({ error: 'Missing cv_text, role, or cohort' });

  try {
    const extracted  = await extractFacts(cv_text, GROQ_KEY);
    const ruleScore  = applyRubric(extracted, cohort, role);
    const result     = await validateAndGenerate(extracted, ruleScore, cohort, role, GROQ_KEY);

    // Save to Supabase if configured
    if (SUPA_URL && SUPA_KEY && applicant) {
      await saveApplication(result, extracted, applicant, job, cohort, role, cv_text, SUPA_URL, SUPA_KEY);
    }

    return res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify(result) }]
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════
// SUPABASE SAVE
// ═══════════════════════════════════════

async function saveApplication(result, extracted, applicant, job, cohort, role, cvText, supaUrl, supaKey) {
  const row = {
    job_id:          job?.id     || null,
    job_title:       job?.title  || role,
    company:         job?.company || null,
    first_name:      applicant?.first_name || null,
    last_name:       applicant?.last_name  || null,
    email:           applicant?.email      || null,
    visa:            applicant?.visa       || null,
    cohort,
    role,
    cv_text:         cvText.substring(0, 8000),
    percentile:      result.percentile,
    tier_label:      result.tier_label,
    projects_score:  result.projects_score,
    education_score: result.education_score,
    domain_score:    result.extra_score || result.other_score,
    headline:        result.headline,
    summary:         result.summary,
    strengths:       JSON.stringify(result.strengths || []),
    gaps:            JSON.stringify(result.gaps || []),
    free_tip:        JSON.stringify(result.free_tip || {}),
    stage:           'Applied'
  };

  await fetch(supaUrl + '/rest/v1/applications', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        supaKey,
      'Authorization': 'Bearer ' + supaKey,
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(row)
  });
}

// ═══════════════════════════════════════
// LAYER 1 — EXTRACTION
// ═══════════════════════════════════════

async function extractFacts(cvText, apiKey) {
  const prompt = `Extract structured facts from this CV. Be literal. Do not score or judge.

CV:
${cvText.substring(0, 4000)}

Return ONLY valid JSON:
{
  "institutions": [],
  "degrees": [],
  "gpa": null,
  "is_top_class": false,
  "internships": [{"company":"","role":"","description":"","duration_months":null}],
  "full_time_jobs": [{"company":"","role":"","description":"","duration_months":null,"was_promoted":false}],
  "projects": [{"name":"","description":"","has_real_users":false,"github_stars":null,"in_production":false}],
  "publications": [{"title":"","venue":"","is_top_venue":false}],
  "competitions": [],
  "skills_listed": [],
  "phd": false,
  "phd_institution": null,
  "mba": false,
  "mba_institution": null,
  "leadership_roles": [],
  "quantified_achievements": [],
  "total_years_experience": 0
}`;
  const data = await callGroq(prompt, apiKey, 0.1, 1200);
  try {
    const text = data?.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text.replace(/```json|```/g,'').trim());
  } catch { return {}; }
}

// ═══════════════════════════════════════
// LAYER 2 — RULES
// ═══════════════════════════════════════

const ELITE_UNIS = [
  'mit','harvard','stanford','princeton','caltech','yale','columbia','cornell',
  'oxford','cambridge','eth zurich','epfl','imperial college',
  'iit bombay','iit delhi','iit madras','iit kharagpur','iit kanpur','iit roorkee',
  'iim ahmedabad','iim bangalore','iim calcutta',
  'nus','ntu','peking university','tsinghua',
  'ecole polytechnique','hec paris','insead','lbs','wharton','hbs',
  'booth','sloan','haas','kellogg','bits pilani','nit trichy',
  'university of toronto','waterloo','mcgill','lse','ucl'
];
const ELITE_EMPS = [
  'jane street','citadel','de shaw','d.e. shaw','two sigma','renaissance',
  'bridgewater','point72','millennium','virtu','optiver','akuna',
  'goldman sachs','morgan stanley','jp morgan','jpmorgan',
  'blackstone','blackrock','kkr','carlyle',
  'mckinsey','bain','bcg','boston consulting',
  'google','deepmind','openai','anthropic','meta ai',
  'microsoft research','stripe','palantir',
  'sequoia','andreessen','a16z','yc','y combinator'
];
const TIER2_EMPS = [
  'deloitte','pwc','ey','kpmg','accenture','oliver wyman',
  'uber','airbnb','netflix','salesforce','adobe','linkedin',
  'bytedance','grab','gojek','flipkart','razorpay','zepto','swiggy',
  'deutsche bank','credit suisse','ubs','barclays','hsbc','citi','bank of america'
];

const isEliteUni = n => n && ELITE_UNIS.some(e => n.toLowerCase().includes(e));
const isEliteEmp = n => n && ELITE_EMPS.some(e => n.toLowerCase().includes(e));
const isTier2Emp = n => n && TIER2_EMPS.some(e => n.toLowerCase().includes(e));

function getUniTier(inst=[]) {
  if (inst.some(isEliteUni)) return 'elite';
  if (inst.join(' ').toLowerCase().match(/iit|iim/)) return 'elite';
  return inst.length ? 'average' : 'unknown';
}

function scoreInternships(interns=[]) {
  if (!interns.length) return { score:0, tier:'none' };
  let best=0, tier='none';
  for (const i of interns) {
    const desc = i.description||'';
    const didReal = /built|shipped|deployed|led|created|improved|launched/i.test(desc);
    const hasNum  = /\d+%|\$\d+|\d+k|users|revenue|production/i.test(desc);
    const q = hasNum ? 1.0 : didReal ? 0.85 : 0.6;
    const base = isEliteEmp(i.company) ? 15 : isTier2Emp(i.company) ? 11 : 6;
    if (isEliteEmp(i.company)) tier='elite';
    else if (isTier2Emp(i.company) && tier!=='elite') tier='tier2';
    else if (tier==='none') tier='other';
    if (base*q > best) best = base*q;
  }
  return { score: Math.min(Math.round(best),15), tier };
}

function scoreProjects(projs=[]) {
  let t=0;
  for (const p of projs) {
    let pts=4;
    if (p.in_production) pts+=5;
    if (p.has_real_users) pts+=4;
    if ((p.github_stars||0)>=100) pts+=4;
    else if ((p.github_stars||0)>=10) pts+=2;
    t+=pts;
  }
  return Math.min(t,20);
}

function scoreDomain(e, role) {
  const skills = (e.skills_listed||[]).join(' ').toLowerCase();
  const allText = [...(e.internships||[]).map(i=>i.description), ...(e.full_time_jobs||[]).map(j=>j.description), ...(e.projects||[]).map(p=>p.description)].join(' ').toLowerCase();
  const r = role.toLowerCase();
  let sm=0, rs=0;
  if (r.includes('software')||r.includes('engineer')||r.includes('swe')||r.includes('developer')) {
    sm = ['python','java','javascript','typescript','golang','c++'].filter(s=>skills.includes(s)).length>=2?15:8;
    rs = (/system design|distributed|microservice|backend|frontend/i.test(allText)?7:0)+(/leetcode|codeforces/i.test(allText+skills)?4:0)+(/github|open.?source/i.test(allText+skills)?4:0);
  } else if (r.includes('quant')||r.includes('trading')||r.includes('investment bank')||r.includes('ib')) {
    sm = ['python','r','matlab','statistics','finance'].filter(s=>skills.includes(s)).length>=2?15:7;
    rs = (/olympiad|stochastic|derivatives|pricing|portfolio/i.test(allText+skills)?8:0)+(/bloomberg|dcf|valuation|equity/i.test(allText)?7:0);
  } else if (r.includes('machine learning')||r.includes('ml')||r.includes('data scientist')||r.includes('ai')) {
    sm = ['pytorch','tensorflow','python','machine learning','deep learning'].filter(s=>skills.includes(s)).length>=2?15:7;
    rs = ((e.publications||[]).length>0?7:0)+(/kaggle/i.test(allText+skills)?4:0)+(/model.*production|mlops/i.test(allText)?4:0);
  } else if (r.includes('consult')||r.includes('strategy')) {
    sm = /structured|framework|case|strategy/i.test(allText)?12:6;
    rs = ((e.competitions||[]).some(c=>/case|consult/i.test(c))?10:0)+(/structured thinking/i.test(allText)?5:0);
  } else if (r.includes('product')) {
    sm = /shipped|launched|roadmap|user research|a\/b test/i.test(allText)?12:5;
    rs = (e.quantified_achievements||[]).length>0?12:5;
  } else { sm=8; rs=7; }
  return Math.min(sm+Math.min(rs,15),30);
}

function applyRubric(e, cohort, role) {
  const insts  = e.institutions||[];
  const interns = e.internships||[];
  const jobs   = e.full_time_jobs||[];
  const projs  = e.projects||[];
  const pubs   = e.publications||[];
  const comps  = e.competitions||[];
  const quant  = e.quantified_achievements||[];
  const uniTier = getUniTier(insts);
  const internScore = scoreInternships(interns);
  const projScore   = scoreProjects(projs);
  const pubScore    = Math.min(pubs.filter(p=>p.is_top_venue).length*10+pubs.filter(p=>!p.is_top_venue).length*5,10);
  let A=0,B=0,C=0;

  if (cohort==='fresher') {
    A = Math.min(projScore+internScore.score+Math.min(pubScore,10),45);
    const schoolPts = uniTier==='elite'?15:uniTier==='average'?7:3;
    let gpaPts=0;
    if (e.gpa) { const n=parseFloat(String(e.gpa)); const s=String(e.gpa); if(s.includes('/10')) gpaPts=n>=9?7:n>=8?5:n>=7?3:1; else if(s.includes('/4')) gpaPts=n>=3.8?7:n>=3.5?5:n>=3?3:1; else gpaPts=e.is_top_class?6:3; } else gpaPts=e.is_top_class?5:0;
    const extraPts = comps.length>=2?3:comps.length===1?2:0;
    const phdBonus = e.phd?(isEliteUni(e.phd_institution||'')?12:6):0;
    B = Math.min(schoolPts+gpaPts+extraPts+phdBonus,35);
  } else if (cohort==='mid') {
    const outPts   = quant.length>0?Math.min(10+quant.length*2,20):jobs.length?10:4;
    const promPts  = jobs.some(j=>j.was_promoted)?15:jobs.length>=2?9:5;
    const allC     = [...jobs.map(j=>j.company),...interns.map(i=>i.company)];
    const eC       = allC.filter(isEliteEmp).length;
    const t2C      = allC.filter(isTier2Emp).length;
    const compPts  = eC>=2?10:eC===1?7:t2C>=1?4:2;
    A = Math.min(outPts+promPts+compPts,45);
    const schoolPts = uniTier==='elite'?5:2;
    const mbaPts   = e.mba?(isEliteUni(e.mba_institution||'')?10:5):0;
    const phdPts   = e.phd?(isEliteUni(e.phd_institution||'')?5:3):0;
    B = Math.min(schoolPts+mbaPts+phdPts,25);
  } else {
    const hasTeam  = quant.some(q=>/\d{2,}.*team|team.*\d{2,}/i.test(q));
    const hasPnl   = quant.some(q=>/\$\d+m|million|billion|revenue/i.test(q));
    const leadPts  = hasTeam&&hasPnl?20:hasTeam||hasPnl?14:(e.leadership_roles||[]).length?8:4;
    const recPts   = pubs.length>0||comps.length>0?12:5;
    const exitPts  = quant.some(q=>/ipo|acquisition|series [cde]/i.test(q))?10:3;
    A = Math.min(leadPts+recPts+exitPts,45);
    const schoolPts = uniTier==='elite'?5:2;
    const mbaPts   = e.mba?(isEliteUni(e.mba_institution||'')?12:6):0;
    const phdPts   = e.phd?(isEliteUni(e.phd_institution||'')?8:4):0;
    B = Math.min(schoolPts+mbaPts+phdPts,25);
  }

  C = scoreDomain(e, role);
  let raw = Math.min(Math.max(A+B+C,0),100);

  const allI = [...insts,e.phd_institution,e.mba_institution].filter(Boolean);
  const allE = [...interns.map(i=>i.company),...jobs.map(j=>j.company)].filter(Boolean);
  const eU   = allI.filter(isEliteUni).length;
  const eE   = allE.filter(isEliteEmp).length;
  const tot  = eU+eE;
  if (tot>=3) raw=Math.max(raw,97);
  else if (tot===2) raw=Math.max(raw,93);
  else if (tot===1) raw=Math.min(raw+4,96);

  return { raw, percentile:rawToPct(raw), A, B, C, tot, uniTier };
}

function rawToPct(raw) {
  const bp = [{r:0,p:0},{r:20,p:5},{r:30,p:12},{r:40,p:22},{r:50,p:38},{r:58,p:52},{r:65,p:65},{r:72,p:75},{r:78,p:83},{r:83,p:88},{r:88,p:92},{r:92,p:95},{r:96,p:97},{r:99,p:99},{r:100,p:99.5}];
  for (let i=1;i<bp.length;i++) {
    if (raw<=bp[i].r) {
      const t=(raw-bp[i-1].r)/(bp[i].r-bp[i-1].r);
      return Math.round((bp[i-1].p+t*(bp[i].p-bp[i-1].p))*10)/10;
    }
  }
  return 99.5;
}

// ═══════════════════════════════════════
// LAYER 3 — VALIDATION + OUTPUT
// ═══════════════════════════════════════

async function validateAndGenerate(e, rs, cohort, role, apiKey) {
  const cLabel = {fresher:'FRESHER (0-2yr)',mid:'MID-LEVEL (3-7yr)',senior:'SENIOR (8+yr)'}[cohort];
  const prompt = `You are TopScreen talent scoring validator. Validate this score and generate honest output.

COHORT: ${cLabel}
ROLE: ${role}
RULE SCORE: ${rs.raw}/100 → ${rs.percentile}th percentile
Block A (Output/Experience): ${rs.A}/45
Block B (Academic): ${rs.B}/25
Block C (Domain Fit): ${rs.C}/30
Elite signals: ${rs.tot}

PROFILE:
Institutions: ${(e.institutions||[]).join(', ')||'None'}
Internships: ${(e.internships||[]).map(i=>i.company+': '+i.description).join(' | ')||'None'}
Jobs: ${(e.full_time_jobs||[]).map(j=>j.company+' ('+j.role+'): '+j.description).join(' | ')||'None'}
Projects: ${(e.projects||[]).slice(0,3).map(p=>p.name+': '+p.description).join(' | ')||'None'}
Publications: ${(e.publications||[]).length} papers
Competitions: ${(e.competitions||[]).join(', ')||'None'}
GPA: ${e.gpa||'Not mentioned'}
PhD: ${e.phd?'Yes - '+e.phd_institution:'No'}
MBA: ${e.mba?'Yes - '+e.mba_institution:'No'}
Quantified: ${(e.quantified_achievements||[]).join(' | ')||'None'}

CALIBRATION: 0-40=weak, 41-65=average, 66-80=solid, 81-92=strong, 93-99=elite
Adjust -10 to +10 only if clearly wrong.
Adjust UP: self-taught founders, non-traditional paths, regional institution undervaluation.
Adjust DOWN: inflated task descriptions, no evidence behind claims.

Return ONLY valid JSON:
{
  "adjustment": 0,
  "headline": "6-8 word honest headline",
  "summary": "2-3 honest sentences naming specific companies and institutions",
  "tier_label": "Top 5%",
  "strengths": ["specific with evidence","specific with evidence","specific with evidence"],
  "gaps": ["constructive specific gap","constructive specific gap","constructive specific gap"],
  "free_tip": {"action":"single most impactful action","gain":"+X to +Y percentile points","timeframe":"realistic timeframe"}
}`;

  const data = await callGroq(prompt, apiKey, 0.2, 800);
  let v={};
  try {
    const text = data?.choices?.[0]?.message?.content||'{}';
    v = JSON.parse(text.replace(/```json|```/g,'').trim());
  } catch {
    v = { adjustment:0, headline:'Profile scored', summary:'Candidate scored based on extracted profile.', tier_label:tierLabel(rs.percentile), strengths:['Profile submitted'], gaps:['Add more detail for better scoring'], free_tip:{action:'Expand project descriptions with specific outcomes',gain:'+5 percentile points',timeframe:'30 minutes'} };
  }

  const adj = Math.max(-10,Math.min(10,v.adjustment||0));
  const finalRaw = Math.max(0,Math.min(100,rs.raw+adj));
  const finalPct = rawToPct(finalRaw);

  return {
    percentile:      finalPct,
    tier_label:      v.tier_label || tierLabel(finalPct),
    projects_score:  Math.round((rs.A/45)*100),
    education_score: Math.round((rs.B/35)*100),
    extra_score:     Math.round((rs.C/30)*100),
    experience_score:Math.round((rs.A/45)*100),
    other_score:     Math.round((rs.C/30)*100),
    headline:        v.headline||'Profile scored',
    summary:         v.summary||'',
    strengths:       v.strengths||[],
    gaps:            v.gaps||[],
    free_tip:        v.free_tip||{},
    _debug: { raw:rs.raw, adj, blockA:rs.A, blockB:rs.B, blockC:rs.C, eliteSignals:rs.tot }
  };
}

function tierLabel(p) {
  if (p>=99) return 'Top 1%'; if (p>=97) return 'Top 3%'; if (p>=95) return 'Top 5%';
  if (p>=90) return 'Top 10%'; if (p>=85) return 'Top 15%'; if (p>=80) return 'Top 20%';
  if (p>=70) return 'Top 30%'; if (p>=60) return 'Above Average'; if (p>=40) return 'Average';
  return 'Below Average';
}

async function callGroq(prompt, apiKey, temperature, maxTokens) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+apiKey},
    body: JSON.stringify({ model:'llama-3.3-70b-versatile', messages:[{role:'user',content:prompt}], temperature, max_tokens:maxTokens })
  });
  if (!r.ok) throw new Error('Groq '+r.status+': '+(await r.text()).substring(0,200));
  return r.json();
}
