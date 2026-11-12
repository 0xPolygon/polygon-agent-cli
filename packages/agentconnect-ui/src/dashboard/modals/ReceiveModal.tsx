import { ArrowDownLeft } from 'lucide-react';

import { CopyButton } from '../../components/CopyButton.js';
import { ModalShell } from '../../components/ModalShell.js';
import { useCopy } from '../../hooks/useCopy.js';

interface ReceiveModalProps {
  address: string;
  onClose: () => void;
}

export function ReceiveModal({ address, onClose }: ReceiveModalProps) {
  const [copied, copy] = useCopy();
  return (
    <ModalShell
      icon={ArrowDownLeft}
      title="Receive"
      description="From another wallet or exchange. Send only on the Polygon network."
      onClose={onClose}
      action={
        <CopyButton
          variant="default"
          label="Copy address"
          copied={copied === 'address'}
          onClick={() => copy('address', address)}
          className="w-full"
        />
      }
    >
      <span className="rounded-xl bg-background-info px-4 py-3.5 font-mono text-[13px] break-all text-slate-600">
        {address}
      </span>
    </ModalShell>
  );
}
