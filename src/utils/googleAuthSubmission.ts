export function shouldAutoSubmitGoogleAuthCode(params: {
  authCode: string;
  isAddDialogOpen: boolean;
  isPending: boolean;
  lastSubmittedAuthCode: string | null;
}): boolean {
  return (
    params.authCode.trim() !== '' &&
    params.isAddDialogOpen &&
    !params.isPending &&
    params.authCode !== params.lastSubmittedAuthCode
  );
}
