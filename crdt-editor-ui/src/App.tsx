import { useState } from 'react';
import SimulatorApp from './SimulatorApp';
import NetworkApp from './NetworkApp';

export default function App() {
  const [mode, setMode] = useState<'simulator' | 'network'>('simulator');

  if (mode === 'network') {
    return <NetworkApp onBack={() => setMode('simulator')} />;
  }

  return <SimulatorApp onSwitchMode={() => setMode('network')} />;
}
