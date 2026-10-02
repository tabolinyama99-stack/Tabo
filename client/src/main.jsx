import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import './styles/tokens.css';
import './styles/components.css';
import './styles/app.css';
import { SessionProvider, useSession } from './lib/session.jsx';
import { ToastProvider, Spinner, Alert } from './components/ui.jsx';
import { Layout } from './components/Layout.jsx';
import Login from './pages/Login.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Sales = lazy(() => import('./pages/Sales.jsx'));
const Purchases = lazy(() => import('./pages/Purchases.jsx'));
const Payments = lazy(() => import('./pages/Payments.jsx'));
const Expenses = lazy(() => import('./pages/Expenses.jsx'));
const Banking = lazy(() => import('./pages/Banking.jsx'));
const Ledger = lazy(() => import('./pages/Ledger.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Work = lazy(() => import('./pages/Work.jsx'));
const AIPage = lazy(() => import('./pages/AIPage.jsx'));
const Admin = lazy(() => import('./pages/admin/Admin.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));

function Guard({ children }) {
  const { loading, me } = useSession();
  const loc = useLocation();
  if (loading) return <Spinner label="Loading TAEL Books…" />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  if (me.user.must_change_password && loc.pathname !== '/profile') return <Navigate to="/profile?force=1" replace />;
  return children;
}

function NotFound() { return <Alert tone="warning" title="Page not found.">The page you are looking for does not exist.</Alert>; }

function App() {
  return <Suspense fallback={<Spinner />}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route index element={<Dashboard />} />
        <Route path="sales/*" element={<Sales />} />
        <Route path="purchases/*" element={<Purchases />} />
        <Route path="payments/*" element={<Payments />} />
        <Route path="expenses/*" element={<Expenses />} />
        <Route path="banking/*" element={<Banking />} />
        <Route path="journals/*" element={<Ledger />} />
        <Route path="accounts/*" element={<Ledger />} />
        <Route path="reports/*" element={<Reports />} />
        <Route path="performance" element={<Reports />} />
        <Route path="approvals" element={<Work />} />
        <Route path="review" element={<Work />} />
        <Route path="documents" element={<Work />} />
        <Route path="ai" element={<AIPage />} />
        <Route path="admin/*" element={<Admin />} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  </Suspense>;
}

createRoot(document.getElementById('root')).render(
  <StrictMode><BrowserRouter><SessionProvider><ToastProvider><App /></ToastProvider></SessionProvider></BrowserRouter></StrictMode>,
);
