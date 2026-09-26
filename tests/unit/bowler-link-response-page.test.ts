import { describe, expect, it } from "vitest";
import { renderPage } from "../../server/routes/bowler-link-response-page";

describe("bowler link response page renderer", () => {
  it("renders a branded declined state and escapes interpolated content", () => {
    const page = renderPage({
      status: 200,
      title: "Invite <title>",
      heading: "Invite declined",
      message: 'The partner said "no" & asked to stop.',
      appUrl: "/bowler-dashboard?next=one&other=two",
      tone: "declined",
    });

    expect(page.status).toBe(200);
    expect(page.html).toContain("result-state-declined");
    expect(page.html).toContain("Declined");
    expect(page.html).toContain("Invite &lt;title&gt;");
    expect(page.html).toContain("The partner said &quot;no&quot; &amp; asked to stop.");
    expect(page.html).toContain("/bowler-dashboard?next=one&amp;other=two");
    expect(page.html).not.toContain("Invite <title>");
  });

  it("provides success, error, and responsive branding hooks", () => {
    const success = renderPage({
      status: 200,
      title: "Invite accepted",
      heading: "Invite accepted",
      message: "You're now linked as payment partners.",
    });
    const error = renderPage({
      status: 409,
      title: "Invite",
      heading: "Invite is no longer pending",
      message: "This invite can't be accepted in its current state.",
    });

    expect(success.html).toContain("result-state-success");
    expect(error.html).toContain("result-state-error");
    expect(success.html).toContain("Instrument Sans");
    expect(success.html).toContain("League Manager");
    expect(success.html).toContain("result-brand-desktop");
    expect(success.html).toContain("/perfect-game-dark-logo.png");
    expect(success.html).toContain("result-brand-mobile");
  });
});
