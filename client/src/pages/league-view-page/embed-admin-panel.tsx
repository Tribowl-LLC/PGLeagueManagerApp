import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Code, ExternalLink, Copy, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import type { League, Organization } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

/**
 * Task #681 — admin panel for the embeddable adult registration
 * form. Shows the share URL + iframe snippet, surfaces the gate
 * status (`allowPublicSignup`) so admins know why an
 * embed might 404, lets admins edit the per-org `allowedEmbedDomains`
 * iframe-ancestors allowlist, and lists the public submissions
 * collected so far. Question authoring is intentionally a JSON
 * editor in v1; a richer drag-and-drop builder is the documented
 * follow-up.
 */
export function EmbedAdminPanel({ league }: { league: League }) {
  const { toast } = useToast();
  const [domainsText, setDomainsText] = useState<string | null>(null);
  const [questionsJson, setQuestionsJson] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const orgId = league.organizationId;

  const orgQuery = useQuery<{ success: true; data: Organization }>({
    queryKey: [`/api/organizations/${orgId}`],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}`);
      if (!r.ok) throw new Error('Failed to load organization');
      return r.json();
    },
    enabled: !!orgId,
  });

  const questionsQuery = useQuery<{ success: true; data: Array<Record<string, unknown>> }>({
    queryKey: [`/api/leagues/${league.id}/registration-questions`],
    queryFn: async () => {
      const r = await fetch(`/api/leagues/${league.id}/registration-questions`);
      if (!r.ok) throw new Error('Failed to load questions');
      return r.json();
    },
  });

  const registrationsQuery = useQuery<{ success: true; data: Array<{ id: number; bowlerId: number | null; status: string; createdAt: string; answers: unknown }> }>({
    queryKey: [`/api/leagues/${league.id}/registration-questions/registrations`],
    queryFn: async () => {
      const r = await fetch(`/api/leagues/${league.id}/registration-questions/registrations`);
      if (!r.ok) throw new Error('Failed to load registrations');
      return r.json();
    },
  });

  const saveDomains = useMutation({
    mutationFn: async (domains: string[]) => {
      return apiRequest(`/api/organizations/${orgId}`, 'PATCH', { allowedEmbedDomains: domains });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}`] });
      toast({ title: 'Allowed domains saved' });
      setDomainsText(null);
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const saveQuestions = useMutation({
    mutationFn: async (questions: unknown[]) => {
      return apiRequest(`/api/leagues/${league.id}/registration-questions`, 'PUT', { questions });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/leagues/${league.id}/registration-questions`] });
      toast({ title: 'Questions saved' });
      setQuestionsJson(null);
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const embedUrl = `${window.location.origin}/embed/register/${league.id}`;
  const iframeSnippet = `<iframe src="${embedUrl}" width="100%" height="900" style="border:0" title="Register for ${league.name}"></iframe>`;
  const enabled = league.allowPublicSignup;
  const org = orgQuery.data?.data;
  const currentDomains = org?.allowedEmbedDomains ?? [];
  const questions = questionsQuery.data?.data ?? [];
  const registrations = registrationsQuery.data?.data ?? [];

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
    toast({ title: 'Copied to clipboard' });
  }

  return (
    <Card data-testid="embed-admin-panel">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="embed-admin-panel-content"
            data-testid="embed-admin-panel-toggle"
            className="w-full text-left rounded-t-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CardHeader>
              <div className="flex items-center gap-2">
                <Code className="size-5" />
                <CardTitle className="text-lg flex-1">Embeddable registration form</CardTitle>
                <ChevronDown
                  className={`size-5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </div>
              <CardDescription>
                Share a public registration page or paste an iframe snippet onto your own site.
                {enabled ? (
                  <Badge variant="default" className="ml-2">Public</Badge>
                ) : (
                  <Badge variant="secondary" className="ml-2">Disabled</Badge>
                )}
              </CardDescription>
            </CardHeader>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount id="embed-admin-panel-content" className="data-[state=closed]:hidden">
          <CardContent className="space-y-6">
        {!enabled && (
          <div className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/40">
            The public embed requires <strong>Allow public signup</strong> to be enabled on this league.
            Open the league settings to toggle them.
          </div>
        )}

        <div>
          <label htmlFor="embed-direct-link" className="text-sm font-medium block mb-1">Direct link</label>
          <div className="flex gap-2">
            <Input id="embed-direct-link" readOnly value={embedUrl} data-testid="embed-direct-url" />
            <Button type="button" variant="outline" size="icon" onClick={() => copy(embedUrl)} aria-label="Copy URL">
              <Copy className="size-4" />
            </Button>
            <Button type="button" variant="outline" size="icon" asChild aria-label="Open in new tab">
              <a href={embedUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /></a>
            </Button>
          </div>
        </div>

        <div>
          <label htmlFor="embed-iframe-snippet" className="text-sm font-medium block mb-1">iframe snippet</label>
          <div className="flex gap-2">
            <Textarea id="embed-iframe-snippet" readOnly value={iframeSnippet} rows={3} className="font-mono text-xs" data-testid="embed-iframe-snippet" />
            <Button type="button" variant="outline" size="icon" onClick={() => copy(iframeSnippet)} aria-label="Copy snippet">
              <Copy className="size-4" />
            </Button>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="embed-allowed-domains" className="text-sm font-medium">Allowed embed domains</label>
            <span className="text-xs text-muted-foreground">{currentDomains.length} domain(s)</span>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Sites in this allowlist may iframe your registration page. One domain per line (e.g. <code>example.com</code>). Leave empty to block iframing.
          </p>
          <Textarea
            id="embed-allowed-domains"
            value={domainsText ?? currentDomains.join('\n')}
            onChange={(e) => setDomainsText(e.target.value)}
            rows={4}
            className="font-mono text-xs"
            data-testid="embed-allowed-domains-input"
          />
          <div className="flex justify-end mt-2 gap-2">
            {domainsText !== null && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setDomainsText(null)}>Cancel</Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={domainsText === null || saveDomains.isPending}
              onClick={() => {
                const list = (domainsText ?? '')
                  .split(/\s+/)
                  .flatMap((s) => {
                    const t = s.trim();
                    return t ? [t] : [];
                  });
                saveDomains.mutate(list);
              }}
            >
              {saveDomains.isPending && <Loader2 className="size-3 mr-2 animate-spin" />}
              Save domains
            </Button>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="embed-custom-questions" className="text-sm font-medium">Custom questions</label>
            <span className="text-xs text-muted-foreground">{questions.length} question(s)</span>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            JSON array of question objects. Each entry: <code>{`{ "label": string, "type": "short_text|long_text|single_select|multi_select|yes_no|number", "required": boolean, "options": string[] }`}</code>
          </p>
          <Textarea
            id="embed-custom-questions"
            value={
              questionsJson ??
              JSON.stringify(
                questions.map((q) => {
                  const obj = q as { label?: unknown; type?: unknown; required?: unknown; options?: unknown };
                  return { label: obj.label, type: obj.type, required: obj.required, options: obj.options ?? [] };
                }),
                null,
                2,
              )
            }
            onChange={(e) => setQuestionsJson(e.target.value)}
            rows={8}
            className="font-mono text-xs"
            data-testid="embed-questions-json"
          />
          <div className="flex justify-end mt-2 gap-2">
            {questionsJson !== null && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setQuestionsJson(null)}>Cancel</Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={questionsJson === null || saveQuestions.isPending}
              onClick={() => {
                try {
                  const parsed = JSON.parse(questionsJson ?? '[]');
                  if (!Array.isArray(parsed)) throw new Error('Must be a JSON array');
                  saveQuestions.mutate(parsed);
                } catch (err) {
                  toast({
                    title: 'Invalid JSON',
                    description: err instanceof Error ? err.message : 'Could not parse',
                    variant: 'destructive',
                  });
                }
              }}
            >
              {saveQuestions.isPending && <Loader2 className="size-3 mr-2 animate-spin" />}
              Save questions
            </Button>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium">Submissions</span>
            <span className="text-xs text-muted-foreground">
              {registrations.length} total
              {league.rosterCap != null && ` · cap ${league.rosterCap}`}
            </span>
          </div>
          {registrations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No public registrations yet.</p>
          ) : (
            <div className="border rounded-md divide-y max-h-72 overflow-auto" data-testid="embed-registrations-list">
              {registrations.slice(0, 100).map((r) => (
                <div key={r.id} className="p-2 text-xs flex items-center justify-between gap-2">
                  <span className="font-mono">#{r.id}</span>
                  <span className="text-muted-foreground">bowler {r.bowlerId ?? '—'}</span>
                  <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
                  <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
