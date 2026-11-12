import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogPrimitive,
  DialogTitle
} from '@polygonlabs/design-system';

import { FundingScreen } from '../../components/FundingScreen.js';

interface AddMoneyModalProps {
  walletAddress: string;
  chainId: number;
  amount?: string;
  onClose: () => void;
}

export function AddMoneyModal({ walletAddress, chainId, amount, onClose }: AddMoneyModalProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        {/* No transform or overflow on the popup: the funding widget draws full-screen
            layers that a transformed or clipping ancestor would confine to this box. */}
        <DialogPrimitive.Popup className="fixed inset-0 m-auto h-fit max-h-[calc(100dvh-2rem)] w-full overflow-y-auto max-w-[calc(100%-2rem)] outline-none sm:max-w-[400px]">
          <DialogTitle className="sr-only">Fund your agent wallet</DialogTitle>
          <FundingScreen
            walletAddress={walletAddress}
            chainId={chainId}
            amount={amount}
            onSkip={onClose}
          />
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
