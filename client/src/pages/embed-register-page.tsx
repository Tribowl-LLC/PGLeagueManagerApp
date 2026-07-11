import { useState, FormEvent } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2, AlertCircle, Plus, Trash2 } from "lucide-react";

type Question = {
  id: number;
  label: string;
  type: "short_text" | "long_text" | "single_select" | "multi_select" | "yes_no" | "number";
  required: boolean;
  options: string[];
  displayOrder: number;
};

type EmbedInfo = {
  league: {
    id: number;
    name: string;
    embedRegistrationFee: number | null;
    rosterCap: number | null;
    registeredCount: number;
    isFull: boolean;
  };
  organization: { id: number; name: string; slug: string; logo: string | null };
  questions: Question[];
};

type Bowler = { id: string; name: string; email: string; phone: string };

function emptyBowler(): Bowler {
  return { id: crypto.randomUUID(), name: "", email: "", phone: "" };
}

export default function EmbedRegisterPage() {
  const params = useParams();
  const leagueId = parseInt(params.leagueId ?? "", 10);

  const { data, isLoading, error } = useQuery<{ success: true; data: EmbedInfo }>({
    queryKey: ["/api/public/embed/leagues", leagueId],
    queryFn: async () => {
      const r = await fetch(`/api/public/embed/leagues/${leagueId}`);
      if (!r.ok) throw new Error((await r.json())?.error?.message ?? "Failed to load");
      return r.json();
    },
    enabled: Number.isFinite(leagueId) && leagueId > 0,
    retry: false,
  });

  const info = data?.data;

  const [bowlers, setBowlers] = useState<Bowler[]>([emptyBowler()]);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  function updateBowler(i: number, patch: Partial<Bowler>) {
    setBowlers((prev) => prev.map((bowler, idx) => (idx === i ? { ...bowler, ...patch } : bowler)));
  }
  function addBowler() {
    if (bowlers.length >= 10) return;
    setBowlers((prev) => [...prev, emptyBowler()]);
  }
  function removeBowler(i: number) {
    setBowlers((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  const submit = useMutation({
    mutationFn: async () => {
      const body = {
        leagueId,
        bowlers: bowlers.map((bowler) => ({
          name: bowler.name.trim(),
          email: bowler.email.trim() || null,
          phone: bowler.phone.trim() || null,
        })),
        answers,
      };
      const r = await fetch("/api/public/embed/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? "Failed to submit");
      }
      return r.json();
    },
    onError: (e: Error) => setSubmitError(e.message),
    onSuccess: () => setSubmitError(null),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="size-4" />
          <AlertDescription>{(error as Error)?.message ?? "Registration is not available."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (info.league.isFull) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>{info.league.name}</CardTitle>
            <CardDescription>{info.organization.name}</CardDescription>
          </CardHeader>
          <CardContent>
            <Alert>
              <AlertCircle className="size-4" />
              <AlertDescription>This league is currently full. Please check back later.</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submit.isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <CheckCircle2 className="size-10 text-green-600" />
            </div>
            <CardTitle>You're registered!</CardTitle>
            <CardDescription>
              Thanks for registering for <strong>{info.league.name}</strong>. {info.organization.name} will be in touch with the next steps.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (bowlers.some((bowler) => !bowler.name.trim())) {
      setSubmitError("Each bowler must have a name");
      return;
    }
    submit.mutate();
  }

  return (
    <div className="min-h-screen bg-background p-4 sm:p-8">
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              {info.organization.logo && (
                <img src={`/api/organizations/slug/${info.organization.slug}/logo`} alt="" className="size-10 object-contain" />
              )}
              <div>
                <CardTitle>{info.league.name}</CardTitle>
                <CardDescription>
                  {info.organization.name}
                  {info.league.rosterCap !== null && info.league.rosterCap !== undefined && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({info.league.registeredCount}/{info.league.rosterCap} spots filled)
                    </span>
                  )}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-6">
              {bowlers.map((bowler, i) => (
                <section key={bowler.id} className="space-y-3 border rounded-md p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Bowler {bowlers.length > 1 ? `#${i + 1}` : "info"}</h3>
                    {bowlers.length > 1 && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeBowler(i)}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div>
                    <Label htmlFor={`bn-${i}`}>Bowler name *</Label>
                    <Input
                      id={`bn-${i}`}
                      value={bowler.name}
                      onChange={(e) => updateBowler(i, { name: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor={`be-${i}`}>Email</Label>
                    <Input
                      id={`be-${i}`}
                      type="email"
                      value={bowler.email}
                      onChange={(e) => updateBowler(i, { email: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`bp-${i}`}>Phone</Label>
                    <Input
                      id={`bp-${i}`}
                      value={bowler.phone}
                      onChange={(e) => updateBowler(i, { phone: e.target.value })}
                    />
                  </div>
                </section>
              ))}

              {bowlers.length < 10 && (
                <Button type="button" variant="outline" onClick={addBowler} className="w-full">
                  <Plus className="size-4 mr-2" />
                  Add another bowler
                </Button>
              )}

              {info.questions.length > 0 && (
                <section className="space-y-3">
                  <h3 className="font-semibold">Additional questions</h3>
                  {info.questions.map((q) => (
                    <QuestionField
                      key={q.id}
                      q={q}
                      value={answers[String(q.id)]}
                      onChange={(v) => setAnswers((prev) => ({ ...prev, [String(q.id)]: v }))}
                    />
                  ))}
                </section>
              )}

              {submitError && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" disabled={submit.isPending} className="w-full">
                {submit.isPending && <Loader2 className="size-4 animate-spin mr-2" />}
                Submit registration
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function QuestionField({
  q,
  value,
  onChange,
}: {
  q: Question;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <Label className="block mb-1">
      {q.label} {q.required && "*"}
    </Label>
  );
  switch (q.type) {
    case "short_text":
      return (
        <div>
          {label}
          <Input value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} required={q.required} />
        </div>
      );
    case "long_text":
      return (
        <div>
          {label}
          <Textarea value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} required={q.required} />
        </div>
      );
    case "number":
      return (
        <div>
          {label}
          <Input
            type="number"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
            required={q.required}
          />
        </div>
      );
    case "yes_no":
      return (
        <div>
          {label}
          <RadioGroup value={(value as string) ?? ""} onValueChange={onChange}>
            {["yes", "no"].map((opt) => (
              <div key={opt} className="flex items-center gap-2">
                <RadioGroupItem value={opt} id={`q${q.id}-${opt}`} />
                <Label htmlFor={`q${q.id}-${opt}`} className="capitalize cursor-pointer">{opt}</Label>
              </div>
            ))}
          </RadioGroup>
        </div>
      );
    case "single_select":
      return (
        <div>
          {label}
          <RadioGroup value={(value as string) ?? ""} onValueChange={onChange}>
            {q.options.map((opt) => (
              <div key={opt} className="flex items-center gap-2">
                <RadioGroupItem value={opt} id={`q${q.id}-${opt}`} />
                <Label htmlFor={`q${q.id}-${opt}`} className="cursor-pointer">{opt}</Label>
              </div>
            ))}
          </RadioGroup>
        </div>
      );
    case "multi_select": {
      const arr = (value as string[]) ?? [];
      return (
        <div>
          {label}
          <div className="space-y-1">
            {q.options.map((opt) => {
              const checked = arr.includes(opt);
              return (
                <div key={opt} className="flex items-center gap-2">
                  <Checkbox
                    id={`q${q.id}-${opt}`}
                    checked={checked}
                    onCheckedChange={(v) => {
                      const next = v ? [...arr, opt] : arr.filter((o) => o !== opt);
                      onChange(next);
                    }}
                  />
                  <Label htmlFor={`q${q.id}-${opt}`} className="cursor-pointer">{opt}</Label>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
  }
}
