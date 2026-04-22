// src/ats/detector.ts — detect which ATS a job URL uses

export type ATSType = "lever" | "greenhouse" | "workday" | "ashby" | "unknown";

export interface ATSInfo {
  type: ATSType;
  applyUrl: string;  // direct apply URL (may differ from listing URL)
  canAutoApply: boolean;
}

export function detectATS(url: string): ATSInfo {
  const u = url.toLowerCase();

  // Lever — jobs.lever.co or lever.co
  if (u.includes("lever.co")) {
    return { type: "lever", applyUrl: url, canAutoApply: true };
  }

  // Greenhouse — boards.greenhouse.io, job-boards.greenhouse.io, or any greenhouse.io subdomain
  if (u.includes("greenhouse.io")) {
    return { type: "greenhouse", applyUrl: url, canAutoApply: true };
  }

  // Workday — myworkdayjobs.com or *.workday.com/*/jobs
  if (u.includes("myworkdayjobs.com") || (u.includes("workday.com") && u.includes("/jobs"))) {
    return { type: "workday", applyUrl: url, canAutoApply: true };
  }

  // Ashby — jobs.ashbyhq.com or ashbyhq.com
  if (u.includes("ashbyhq.com")) {
    return { type: "ashby", applyUrl: url, canAutoApply: false };
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
