import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Mail } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { EmailTemplate, Organization, ApiResponse } from "@shared/schema";
import { EmailTemplatesList } from "./emailtemplatespage/email-templates-list";
import { EmailTemplateEditDialog } from "./emailtemplatespage/email-template-edit-dialog";

export default function EmailTemplatesPage() {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testOrgId, setTestOrgId] = useState<string>("");

  const { data: templatesResponse, isLoading } = useQuery<ApiResponse<EmailTemplate[]>>({
    queryKey: ["/api/admin/email-templates"],
  });

  const { data: orgsResponse } = useQuery<ApiResponse<Organization[]>>({
    queryKey: ["/api/organizations"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: { subject?: string; body?: string; active?: boolean } }) => {
      return apiRequest(`/api/admin/email-templates/${id}`, "PATCH", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/email-templates"] });
      toast({ title: "Template Updated", description: "Email template saved successfully." });
      setEditingTemplate(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      return apiRequest(`/api/admin/email-templates/${id}`, "PATCH", { active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/email-templates"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const sendTestMutation = useMutation({
    mutationFn: async ({ id, toEmail, organizationId }: { id: number; toEmail: string; organizationId?: string }) => {
      return apiRequest(`/api/admin/email-templates/${id}/send-test`, "POST", { toEmail, organizationId: organizationId || undefined });
    },
    onSuccess: () => {
      toast({ title: "Test Email Sent", description: `A sample email was sent to ${testEmail}.` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to Send", description: error.message, variant: "destructive" });
    },
  });

  const openEditor = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setEditSubject(template.subject);
    setEditBody(template.body);
    setEditActive(template.active);
    setShowPreview(false);
  };

  const handleSave = () => {
    if (!editingTemplate) return;
    updateMutation.mutate({
      id: editingTemplate.id,
      data: { subject: editSubject, body: editBody, active: editActive },
    });
  };

  const templates = templatesResponse?.data || [];

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Email Templates</h1>
          <p className="text-muted-foreground">Manage every email authored and sent by LeagueVault, including account, payment, security, and administrator notifications. Provider-generated Square or SendGrid platform notices are not managed here.</p>
        </div>

        {isLoading ? (
          <PageLoadingState fullPage={false} />
        ) : templates.length === 0 ? (
          <div className="rounded-lg border p-8 text-center">
            <Mail className="size-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="text-sm font-medium">No email templates</h3>
            <p className="text-sm text-muted-foreground mt-1">Email templates will appear here once they are created.</p>
          </div>
        ) : (
          <EmailTemplatesList
            templates={templates}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            openEditor={openEditor}
            toggleMutation={toggleMutation}
          />
        )}

        <EmailTemplateEditDialog
          editingTemplate={editingTemplate}
          setEditingTemplate={setEditingTemplate}
          editSubject={editSubject}
          setEditSubject={setEditSubject}
          editBody={editBody}
          setEditBody={setEditBody}
          editActive={editActive}
          setEditActive={setEditActive}
          showPreview={showPreview}
          setShowPreview={setShowPreview}
          testEmail={testEmail}
          setTestEmail={setTestEmail}
          testOrgId={testOrgId}
          setTestOrgId={setTestOrgId}
          orgsResponse={orgsResponse}
          sendTestMutation={sendTestMutation}
          updateMutation={updateMutation}
          handleSave={handleSave}
        />
      </div>
      </ErrorBoundary>
    </Layout>
  );
}
