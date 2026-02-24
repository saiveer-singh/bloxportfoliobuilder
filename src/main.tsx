import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const deploymentUrl = import.meta.env.VITE_CONVEX_URL?.trim();
if (!deploymentUrl) {
  throw new Error(
    "Missing VITE_CONVEX_URL environment variable. Set it in .env.local to connect to your Convex deployment.",
  );
}
const convex = new ConvexReactClient(deploymentUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
