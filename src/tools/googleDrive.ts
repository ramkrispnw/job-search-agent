// src/tools/googleDrive.ts — read/write files to Google Drive

import { google } from "googleapis";

export function getAuthClient(clientId: string, clientSecret: string, refreshToken: string) {
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export async function createFolder(
  auth: any,
  name: string,
  parentFolderId: string
): Promise<string> {
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId]
    },
    fields: "id"
  });
  return res.data.id!;
}

export async function uploadFile(
  auth: any,
  folderId: string,
  fileName: string,
  content: string,
  mimeType = "text/markdown"
): Promise<string> {
  const drive = google.drive({ version: "v3", auth });
  const { Readable } = await import("stream");

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: Readable.from([content])
    },
    fields: "id, webViewLink"
  });

  return res.data.webViewLink ?? res.data.id!;
}

export async function uploadAsGoogleDoc(
  auth: any,
  folderId: string,
  fileName: string,
  content: string
): Promise<string> {
  const drive = google.drive({ version: "v3", auth });
  const { Readable } = await import("stream");

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: "application/vnd.google-apps.document",
      parents: [folderId]
    },
    media: {
      mimeType: "text/plain",
      body: Readable.from([content])
    },
    fields: "id, webViewLink"
  });

  return res.data.webViewLink ?? res.data.id!;
}

export async function uploadDocxBuffer(
  auth: any,
  folderId: string,
  fileName: string,
  buffer: Buffer
): Promise<string> {
  const drive = google.drive({ version: "v3", auth });
  const { Readable } = await import("stream");

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: Readable.from(buffer)
    },
    fields: "id, webViewLink"
  });

  return res.data.webViewLink ?? res.data.id!;
}

export async function verifyFolderAccess(
  auth: any,
  folderId: string
): Promise<boolean> {
  try {
    const drive = google.drive({ version: "v3", auth });
    await drive.files.get({ fileId: folderId, fields: "id, name" });
    return true;
  } catch {
    return false;
  }
}
