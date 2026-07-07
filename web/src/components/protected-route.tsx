import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { getToken } from "@/lib/api";

// Guards authenticated routes. A missing token bounces to /login. Token
// validity is enforced server-side on each API call (a 401 auto-logs-out).
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (!getToken()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}
