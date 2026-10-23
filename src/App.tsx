import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RoleProvider } from './contexts/RoleContext';
import { RequireLogin, RequireSection } from './components/RequireLogin';

// Standalone shop-floor screens follow the matching dashboard section's grant.
const WAREHOUSE_SECTIONS = ['/dashboard/warehouse-entry'];
const BATCH_SECTIONS = ['/dashboard/batch-entry'];
import { PlantScopeProvider } from './contexts/PlantScopeContext';
import { NotificationsProvider } from './contexts/NotificationsContext';
import { TodoProvider } from './contexts/TodoContext';
import { BlacklistProvider } from './contexts/BlacklistContext';
import { AnomalyProvider } from './contexts/AnomalyContext';
import { BusyCompanyProvider } from './contexts/BusyCompanyContext';
import { BusyFeedSync } from './components/BusyFeedSync';
import { OcrJobsProvider } from './contexts/OcrJobsContext';
import { BrandLoader } from './components/brand/BrandLoader';

// Layout + auth load eagerly (shell + entry — always needed, small).
import { DashboardLayout } from './components/layout/DashboardLayout';
import { PurchaseLayout } from './routes/dashboard/purchase/PurchaseLayout';
import { Login } from './routes/auth/Login';

// Page components are code-split so each route ships its own chunk — heavy deps
// (leaflet, recharts, xlsx, the OCR client) no longer bloat the initial bundle.
const Overview         = lazy(() => import('./routes/dashboard/Overview').then(m => ({ default: m.Overview })));
const Todo             = lazy(() => import('./routes/dashboard/Todo').then(m => ({ default: m.Todo })));
const Sales            = lazy(() => import('./routes/dashboard/Sales').then(m => ({ default: m.Sales })));
const CPMStock         = lazy(() => import('./routes/dashboard/CPMStock').then(m => ({ default: m.CPMStock })));
const BatchSheet       = lazy(() => import('./routes/dashboard/BatchSheet').then(m => ({ default: m.BatchSheet })));
const CustomerHistory  = lazy(() => import('./routes/dashboard/CustomerHistory').then(m => ({ default: m.CustomerHistory })));
const NightManagerBoard = lazy(() => import('./routes/dashboard/NightManagerBoard').then(m => ({ default: m.NightManagerBoard })));
const OilRatioTable    = lazy(() => import('./routes/dashboard/OilRatioTable').then(m => ({ default: m.OilRatioTable })));
const AuditLog         = lazy(() => import('./routes/dashboard/AuditLog').then(m => ({ default: m.AuditLog })));
const NightEntry       = lazy(() => import('./routes/dashboard/NightEntry').then(m => ({ default: m.NightEntry })));
const BatchEntry       = lazy(() => import('./routes/dashboard/BatchEntry').then(m => ({ default: m.BatchEntry })));
const WarehouseEntry   = lazy(() => import('./routes/dashboard/WarehouseEntry').then(m => ({ default: m.WarehouseEntry })));
const DailyLogPage     = lazy(() => import('./routes/dashboard/DailyLogPage').then(m => ({ default: m.DailyLogPage })));
const UserManagement   = lazy(() => import('./routes/dashboard/UserManagement').then(m => ({ default: m.UserManagement })));
const Blacklist        = lazy(() => import('./routes/dashboard/Blacklist').then(m => ({ default: m.Blacklist })));
const UploadHistory    = lazy(() => import('./routes/dashboard/UploadHistory').then(m => ({ default: m.UploadHistory })));
const AnomalyDashboard = lazy(() => import('./routes/dashboard/AnomalyDashboard').then(m => ({ default: m.AnomalyDashboard })));
const AnomalyOperationsCenter = lazy(() => import('./routes/dashboard/AnomalyOperationsCenter').then(m => ({ default: m.AnomalyOperationsCenter })));
const CostIntelligence = lazy(() => import('./routes/dashboard/CostIntelligence').then(m => ({ default: m.CostIntelligence })));
const Benchmarking = lazy(() => import('./routes/dashboard/Benchmarking').then(m => ({ default: m.Benchmarking })));
const PredictiveQCBoard = lazy(() => import('./routes/dashboard/PredictiveQCBoard').then(m => ({ default: m.PredictiveQCBoard })));
const WorkingCapital = lazy(() => import('./routes/dashboard/WorkingCapital').then(m => ({ default: m.WorkingCapital })));
const OwnerLayer = lazy(() => import('./routes/dashboard/OwnerLayer').then(m => ({ default: m.OwnerLayer })));

// Purchase sub-routes
const StoreRequisitions = lazy(() => import('./routes/dashboard/purchase/StoreRequisitions').then(m => ({ default: m.StoreRequisitions })));
const FAR             = lazy(() => import('./routes/dashboard/purchase/FAR').then(m => ({ default: m.FAR })));
const Maintenance     = lazy(() => import('./routes/dashboard/purchase/Maintenance').then(m => ({ default: m.Maintenance })));
const ActivityLog     = lazy(() => import('./routes/dashboard/purchase/ActivityLog').then(m => ({ default: m.ActivityLog })));
const PurchaseOrders  = lazy(() => import('./routes/dashboard/purchase/PurchaseOrders').then(m => ({ default: m.PurchaseOrders })));
const MarineInsurance = lazy(() => import('./routes/dashboard/purchase/MarineInsurance').then(m => ({ default: m.MarineInsurance })));
const Labour          = lazy(() => import('./routes/dashboard/purchase/Labour').then(m => ({ default: m.Labour })));
const QRManagement    = lazy(() => import('./routes/dashboard/purchase/QRManagement').then(m => ({ default: m.QRManagement })));
const QRDetail        = lazy(() => import('./routes/dashboard/purchase/QRDetail').then(m => ({ default: m.QRDetail })));

// Standalone asset profile (QR landing) — full page, no sidebar.
const AssetProfile    = lazy(() => import('./routes/asset/AssetProfile').then(m => ({ default: m.AssetProfile })));

// L1 Operator apps (standalone — no DashboardLayout)
const CheckIn     = lazy(() => import('./routes/night-manager/CheckIn').then(m => ({ default: m.CheckIn })));
const Warehouse   = lazy(() => import('./routes/warehouse/Warehouse').then(m => ({ default: m.Warehouse })));
const BatchLogger = lazy(() => import('./routes/operator/BatchLogger').then(m => ({ default: m.BatchLogger })));

/** Lightweight fallback while a route chunk loads. */
function RouteFallback() {
  return <BrandLoader fullScreen={false} label="Loading…" />;
}

function App() {
  return (
    // RoleProvider wraps BrowserRouter so the role context is available
    // everywhere in the app, including inside router-dependent hooks.
    <RoleProvider>
      <PlantScopeProvider>
      <NotificationsProvider>
      <TodoProvider>
      <BlacklistProvider>
      <BusyCompanyProvider>
        <BusyFeedSync />
      <AnomalyProvider>
      <OcrJobsProvider>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Auth */}
          <Route path="/login" element={<Login />} />

          {/* Dashboard — protected layout */}
          <Route path="/dashboard" element={<DashboardLayout />}>
            <Route index element={<Overview />} />
            <Route path="todo" element={<Todo />} />

            {/* Purchase hub — nested layout with shared stage flow + sub-tabs */}
            <Route path="purchase" element={<PurchaseLayout />}>
              <Route index element={<Navigate to="far" replace />} />
              <Route path="far"      element={<FAR />} />
              <Route path="maint"    element={<Maintenance />} />
              <Route path="activity" element={<ActivityLog />} />
              <Route path="storereq" element={<StoreRequisitions />} />
              <Route path="purchase" element={<PurchaseOrders />} />
              <Route path="marine"   element={<MarineInsurance />} />
              <Route path="labour"   element={<Labour />} />
              <Route path="qr"       element={<QRManagement />} />
              <Route path="qr/:qrKey" element={<QRDetail />} />
            </Route>

            {/* Main tabs */}
            <Route path="sales"         element={<Sales />} />
            <Route path="stock"         element={<CPMStock />} />
            <Route path="batches"       element={<BatchSheet />} />
            <Route path="customers"     element={<CustomerHistory />} />
            <Route path="night-manager" element={<NightManagerBoard />} />
            <Route path="oil-ratio"     element={<OilRatioTable />} />
            <Route path="audit"         element={<AuditLog />} />
            {/* Embedded L1 app views — full dashboard layout but single-purpose */}
            <Route path="night-entry"       element={<NightEntry />} />
            <Route path="batch-entry"       element={<BatchEntry />} />
            <Route path="warehouse-entry"   element={<WarehouseEntry />} />
            <Route path="daily-log"         element={<DailyLogPage />} />
            <Route path="users"             element={<UserManagement />} />
            <Route path="blacklist"         element={<Blacklist />} />
            {/* Admin-only: delete data imported through an incorrect CSV/Excel
                upload. Gated by the '*' route wildcard that only admin holds,
                and again by the delete_import_batch capability inside the RPC. */}
            <Route path="admin/uploads"     element={<UploadHistory />} />
            <Route path="anomalies"         element={<AnomalyDashboard />} />
            <Route path="anomaly-center"    element={<AnomalyOperationsCenter />} />
            <Route path="cost-intelligence" element={<CostIntelligence />} />
            <Route path="benchmarking"      element={<Benchmarking />} />
            <Route path="predictive-qc"     element={<PredictiveQCBoard />} />
            <Route path="working-capital"   element={<WorkingCapital />} />
            <Route path="owner"             element={<OwnerLayer />} />
          </Route>

          {/* L1 Operator apps — standalone, no sidebar. Phase 2b: require a login
              so writes are attributed + plant-scoped. */}
          <Route path="/night-manager/check-in" element={<RequireLogin><CheckIn /></RequireLogin>} />
          <Route path="/warehouse"              element={<RequireLogin><RequireSection anyOf={WAREHOUSE_SECTIONS}><Warehouse /></RequireSection></RequireLogin>} />
          <Route path="/warehouse/stock-entry"  element={<RequireLogin><RequireSection anyOf={WAREHOUSE_SECTIONS}><Warehouse /></RequireSection></RequireLogin>} />
          <Route path="/warehouse/requisition"  element={<RequireLogin><RequireSection anyOf={WAREHOUSE_SECTIONS}><Warehouse /></RequireSection></RequireLogin>} />
          <Route path="/operator/batch-logger"  element={<RequireLogin><RequireSection anyOf={BATCH_SECTIONS}><BatchLogger /></RequireSection></RequireLogin>} />

          {/* Asset profile — QR landing page. Standalone + login-gated; the QR
              encodes /asset/<token>. Must be above the catch-all. */}
          <Route path="/asset/:key" element={<RequireLogin><AssetProfile /></RequireLogin>} />

          {/* Default redirect */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
      </OcrJobsProvider>
      </AnomalyProvider>
      </BusyCompanyProvider>
      </BlacklistProvider>
      </TodoProvider>
      </NotificationsProvider>
      </PlantScopeProvider>
    </RoleProvider>
  );
}

export default App;
