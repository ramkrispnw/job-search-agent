// config/types.ts — shared config schema across setup + agent

export interface UserConfig {
  version: string;
  createdAt: string;
  updatedAt: string;

  resume: {
    originalPath: string;       // path to uploaded resume file
    parsedText: string;         // extracted plain text
    lastUpdated: string;
  };

  targetRoles: string[];        // e.g. ["Senior PMM", "Director of Product Marketing"]

  targetCompanyTypes: string[]; // e.g. ["AI-native startups Series B-D", "FAANG AI teams"]

  output: {
    mode: "local" | "google_drive";
    resumeFormat: "google_doc" | "word_doc" | "markdown";
    localPath?: string;          // e.g. ~/job-search-output
    googleDrive?: {
      folderId: string;
      folderName: string;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    };
  };

  anthropicApiKey: string;
}

export const CONFIG_PATH = `${process.env.HOME}/.job-search-agent/config.json`;
export const CONFIG_DIR  = `${process.env.HOME}/.job-search-agent`;
