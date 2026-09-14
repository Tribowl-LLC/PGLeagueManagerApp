import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { Organization } from '@shared/schema';
import { OrganizationFormBody } from './organization-form-body';

interface OrganizationFormDialogProps {
  open: boolean;
  onClose: () => void;
  editOrg?: Organization | null;
}

export function OrganizationFormDialog({ open, onClose, editOrg }: OrganizationFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent viewport="dialog" className="sm:max-w-131.25 overflow-y-auto">
        {/* Keying by edit-target id resets the inner form when the dialog
            switches which org it edits. DialogContent unmounts on close,
            so the body also re-initializes fresh from props on each open. */}
        <OrganizationFormBody key={editOrg?.id ?? 'new'} editOrg={editOrg} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
