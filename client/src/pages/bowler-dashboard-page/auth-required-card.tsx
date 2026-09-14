import { FC } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const AuthRequiredCard: FC = () => {
  return (
    <Card className="mx-auto max-w-md mt-8">
      <CardHeader>
        <CardTitle>Authentication Required</CardTitle>
        <CardDescription>Please log in to view your dashboard</CardDescription>
      </CardHeader>
      <CardContent spacing="normal">
        <p className="text-muted-foreground">
          You need to be logged in to access your bowler dashboard.
        </p>
        <Button asChild className="w-full">
          <Link href="/login">Log In</Link>
        </Button>
      </CardContent>
    </Card>
  );
};
