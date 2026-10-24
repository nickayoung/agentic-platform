// "/" goes to the desk roster; the signed-in layout sends you to sign-in first if needed.
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/roster' });
  },
});
