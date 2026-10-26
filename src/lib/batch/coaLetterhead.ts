/** Letterhead for a Certificate of Analysis, chosen from the batch's plant. */

export interface CoaLetterhead {
  company: string;
  lines: string[];
}

const SPPL_REHLA: CoaLetterhead = {
  company: 'SUNTEK PLASTICIZER PVT. LTD',
  lines: [
    'Near Grasim Industries Ltd.',
    'Garhwa Road Rehla,',
    'Distt. Palamu,',
    'Jharkhand - 822124',
    'GST :20ABCCS7737C1ZO',
  ],
};

export function coaLetterheadForPlant(plantLine?: string | null): CoaLetterhead {
  const raw = (plantLine || '').trim();
  const n = raw.toLowerCase();
  if (!n) return SPPL_REHLA;
  if (/madan|sikand/.test(n)) {
    return { company: 'MADAN CHEMICALS PVT. LTD', lines: ['Sikandrabad,', 'Uttar Pradesh'] };
  }
  if (/ganjam|odisha/.test(n)) {
    return { company: 'SUNTEK CHLORIDES PVT. LTD', lines: ['Ganjam,', 'Odisha'] };
  }
  if (/delhi/.test(n)) {
    return { company: 'SUNTEK CHLORIDES PVT. LTD', lines: ['Delhi'] };
  }
  if (/drum/.test(n)) {
    return { company: 'SUNTEK GROUP', lines: ['Drum Plant, Rehla,', 'Jharkhand'] };
  }
  if ((/chloride|\bscpl\b/.test(n)) && /rehla|jharkhand|garhwa|palamu/.test(n)) {
    return { company: 'SUNTEK CHLORIDES PVT. LTD', lines: ['Rehla, Distt. Palamu,', 'Jharkhand'] };
  }
  if (/plastic|\bsppl\b|rehla|jharkhand|garhwa/.test(n)) return SPPL_REHLA;
  return { company: raw.toUpperCase(), lines: [] };
}
