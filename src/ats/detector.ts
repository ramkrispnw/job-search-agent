// src/ats/detector.ts — detect which ATS a job URL uses

export type ATSType = "lever" | "greenhouse" | "workday" | "ashby" | "unknown";

export interface ATSInfo {
  type: ATSType;
  applyUrl: string;  // direct apply URL (may differ from listing URL)
  canAutoApply: boolean;
}

export function detectATS(url: string): ATSInfo {
  const u = url.toLowerCase();

  if (u.includes("lever.co") || u.includes("jobs.lever.co")) {
    return { type: "lever", applyUrl: url, canAutoApply: true };
  }

  if (u.includes("greenhouse.io") || u.includes("boards.greenhouse.io")) {
    return { type: "greenhouse", applyUrl: url, canAutoApply: true };
  }

  if (u.includes("myworkdayjobs.com") || u.includes("workday.com")) {
    return { type: "workday", applyUrl: url, canAutoApply: true };
  }

  if (u.includes("ashbyhq.com") || u.includes("jobs.ashbyhq.com")) {
    return { type: "ashby", applyUrl: url, canAutoApply: false }; // future
  }

  return { type: "unknown", applyUrl: url, canAutoApply: false };
}

export function getATSLabel(type: ATSType): string {
  const labels: Record<ATSType, string> = {
    lever: "Lever",
    greenhouse: "Greenhouse",
    workday: "Workday",
    ashby: "Ashby",
    unknown: "Unknown ATS"
  };
  return labels[type];
}
