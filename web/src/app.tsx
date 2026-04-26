import { Layout } from "./components/Layout.js";
import { RouterProvider, match, useRoute } from "./router.js";
import { DashboardScreen } from "./screens/dashboard.js";
import { ProjectScreen } from "./screens/project.js";
import { RunScreen } from "./screens/run.js";
import { FindingsScreen } from "./screens/findings.js";

function Routes() {
  const { path } = useRoute();
  if (path === "/" || path === "") {
    return <DashboardScreen />;
  }
  const project = match("/projects/:id", path);
  if (project) return <ProjectScreen projectId={project.id!} />;
  const run = match("/runs/:id", path);
  if (run) return <RunScreen runId={run.id!} />;
  if (path === "/findings") return <FindingsScreen />;
  return <NotFound path={path} />;
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="text-center py-12">
      <h1 className="text-lg font-mono">404</h1>
      <p className="text-sm text-ink-300 mt-2">no route matched {path}</p>
      <p className="mt-4">
        <a href="/" className="text-blue-300 underline">
          back to dashboard
        </a>
      </p>
    </div>
  );
}

export function App() {
  return (
    <RouterProvider>
      <Layout>
        <Routes />
      </Layout>
    </RouterProvider>
  );
}
