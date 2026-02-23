import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const fallbackDeploymentUrl = "https://small-mouse-123.convex.cloud";
const deploymentUrl =
  import.meta.env.VITE_CONVEX_URL?.trim() || fallbackDeploymentUrl;
const convex = new ConvexReactClient(deploymentUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
