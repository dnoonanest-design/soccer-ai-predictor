import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ie.bnfluidequipment.soccerdashboard",
  appName: "Live Soccer Dashboard",
  webDir: "dist/public",
  server: {
    // For production App Store builds, deploy the web app and set this to your HTTPS app URL only if you want live updates.
    // Otherwise Capacitor will serve the built local files from webDir.
    androidScheme: "https",
    iosScheme: "https",
  },
  ios: {
    contentInset: "automatic",
  },
};

export default config;
