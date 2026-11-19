import { describe, expect, test } from "bun:test";
import path from "node:path";
import { detectChromePath, parseChromeLocalState } from "./chrome-scan";

describe("parseChromeLocalState", () => {
  test("extracts signed-in profiles, filters empty emails, and deduplicates against existingEmails", () => {
    const sampleLocalState = JSON.stringify({
      profile: {
        info_cache: {
          Default: {
            name: "Personal",
            user_name: "Alice@Example.com",
            gaia_name: "Alice Smith",
          },
          "Profile 1": {
            name: "Work",
            user_name: "bob@example.com",
            gaia_name: "Bob",
          },
          "Profile 2": {
            name: "Guest-like",
            user_name: "   ",
            gaia_name: "No Email",
          },
          "Profile 3": {
            name: "Unsigned",
            gaia_name: "Unsigned User",
          },
        },
      },
    });

    const profiles = parseChromeLocalState(sampleLocalState, [
      "alice@example.com",
      "other@example.com",
    ]);

    expect(profiles).toEqual([
      {
        profileDir: "Default",
        name: "Personal",
        email: "Alice@Example.com",
        gaiaName: "Alice Smith",
        alreadyAdded: true,
      },
      {
        profileDir: "Profile 1",
        name: "Work",
        email: "bob@example.com",
        gaiaName: "Bob",
        alreadyAdded: false,
      },
    ]);
  });

  test("returns empty array on malformed JSON or missing info_cache", () => {
    expect(parseChromeLocalState("{bad-json", [])).toEqual([]);
    expect(parseChromeLocalState("{}", [])).toEqual([]);
    expect(parseChromeLocalState(JSON.stringify({ profile: {} }), [])).toEqual([]);
  });
});

describe("detectChromePath", () => {
  test("probes ProgramFiles, ProgramFiles(x86), and LOCALAPPDATA in order", () => {
    const env: NodeJS.ProcessEnv = {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    };

    const expectedLocal = path.join(
      "C:\\Users\\test\\AppData\\Local",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe"
    );

    const found = detectChromePath(env, (p) => p === expectedLocal);
    expect(found).toBe(expectedLocal);

    const notFound = detectChromePath(env, () => false);
    expect(notFound).toBeNull();
  });
});
