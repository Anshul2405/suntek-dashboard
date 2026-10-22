import React, { createContext, useContext, useMemo, useState } from 'react';
import { BUSY_COMPANIES, readBusyCompany, writeBusyCompany, type BusyCompanyCode } from '../lib/busyCompanies';

interface BusyCompanyState {
  code: BusyCompanyCode;
  setCode: (code: BusyCompanyCode) => void;
}

const BusyCompanyContext = createContext<BusyCompanyState>({
  code: 'all',
  setCode: () => {},
});

export function BusyCompanyProvider({ children }: { children: React.ReactNode }) {
  const [code, setCodeState] = useState<BusyCompanyCode>(readBusyCompany);
  const value = useMemo<BusyCompanyState>(() => ({
    code,
    setCode: (next) => {
      writeBusyCompany(next);
      setCodeState(next);
    },
  }), [code]);
  return <BusyCompanyContext.Provider value={value}>{children}</BusyCompanyContext.Provider>;
}

export function useBusyCompany() {
  return useContext(BusyCompanyContext);
}

export { BUSY_COMPANIES };
