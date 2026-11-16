import { Toast, ToastPrimitive, useToast } from '@polygonlabs/design-system';

interface ToasterProps {
  children: React.ReactNode;
}

function ToastList() {
  const { toasts } = useToast();
  return (
    // Top centre, below the first line of the page: a toast here never covers the bottom bar or
    // a copy button, and it stays inside narrow screens. The toast cards anchor to the
    // viewport's bottom edge, so the viewport sits one toast height below the top.
    <ToastPrimitive.Viewport className="fixed z-1 top-24 left-1/2 -translate-x-1/2 w-[min(360px,calc(100vw-2rem))] focus:outline-hidden">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </ToastPrimitive.Viewport>
  );
}

export function Toaster({ children }: ToasterProps) {
  return (
    <ToastPrimitive.Provider>
      {children}
      <ToastPrimitive.Portal>
        <ToastList />
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}
