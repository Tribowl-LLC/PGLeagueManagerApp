import { UserCircle, LogOut, Upload, User as UserIcon, Settings, Users as UsersIcon } from "lucide-react";
import { BowlerPaymentLinksSection } from "@/components/bowler-payment-links-section";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { apiRequest, queryClient, csrfFetch, clearCsrfToken } from '@/lib/queryClient';
import { logger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useState, useRef, ChangeEvent } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

interface UserProfileMenuProps {
  user: {
    id: number;
    name: string | null;
    email: string;
    role: string;
    avatar?: string | null;
    // surfaced on /api/user (SAFE_USER_FIELDS includes
    // bowlerId). When set, the user is an adult bowler who can
    // open the "Payment partners" dialog directly from the profile
    // menu — even before they have any links.
    bowlerId?: number | null;
  };
  showName?: boolean;
}

export function UserProfileMenu({ user, showName = false }: UserProfileMenuProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isProfileDialogOpen, setIsProfileDialogOpen] = useState(false);
  const [isPartnersDialogOpen, setIsPartnersDialogOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', 'POST', {});
      clearCsrfToken();
      window.location.href = '/login';
      toast({
        title: "Logged out",
        description: "You have been successfully logged out.",
      });
    } catch (error) {
      logger.error('UserProfileMenu', 'Logout failed', error);
      toast({
        variant: "destructive",
        title: "Logout failed",
        description: "There was a problem logging out. Please try again.",
      });
    }
  };

  // Get initials for the avatar fallback
  const getInitials = () => {
    if (user.name) {
      const nameParts = user.name.split(' ');
      if (nameParts.length > 1) {
        return `${nameParts[0][0]}${nameParts[1][0]}`.toUpperCase();
      }
      return user.name[0].toUpperCase();
    }
    return user.email[0].toUpperCase();
  };

  const triggerFileInput = () => {
    setIsMenuOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check file size (< 2MB)
    if (file.size > 2 * 1024 * 1024) {
      toast({
        variant: "destructive",
        title: "File too large",
        description: "Avatar image must be less than 2MB",
      });
      return;
    }

    // Check file type
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
      toast({
        variant: "destructive",
        title: "Invalid file type",
        description: "Please upload a JPG, PNG, GIF, or WebP image",
      });
      return;
    }

    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('avatar', file);

      const response = await csrfFetch('/api/user/avatar', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      
      // Invalidate user query to refresh data
      queryClient.invalidateQueries({ queryKey: ['/api/user'] });

      toast({
        title: "Avatar updated",
        description: "Your profile picture has been updated successfully.",
      });
    } catch (error) {
      logger.error('UserProfileMenu', 'Avatar upload failed', error);
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: "There was a problem uploading your avatar. Please try again.",
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const openProfileDialog = () => {
    setIsMenuOpen(false);
    setIsProfileDialogOpen(true);
  };

  return (
    <>
      <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button 
            variant="ghost" 
            size={showName ? "sm" : "icon"}
            padding={showName ? "compact" : undefined}
            shape={showName ? undefined : "circular"}
            className={showName ? "flex items-center" : undefined}
          >
            <Avatar size="sm" border="muted">
              {user.avatar ? (
                <AvatarImage src={user.avatar} alt={user.name || user.email} />
              ) : null}
              <AvatarFallback size="base">{getInitials()}</AvatarFallback>
            </Avatar>
            {showName && (
              <span className="ml-2 text-sm font-medium max-w-30 overflow-hidden text-ellipsis whitespace-nowrap">
                {user.name || user.email}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-55">
          <div className="px-3 py-2 text-sm font-medium">
            <div className="truncate font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onClick={openProfileDialog}>
            <div className="flex items-center gap-2">
              <UserIcon className="size-4" />
              <span>Profile</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer" onClick={triggerFileInput}>
            <div className="flex items-center gap-2">
              <Upload className="size-4" />
              <span>{isUploading ? "Uploading…" : "Change Avatar"}</span>
            </div>
          </DropdownMenuItem>
          {user.bowlerId ? (
            <DropdownMenuItem
              className="cursor-pointer"
              data-testid="menu-payment-partners"
              onClick={() => {
                setIsMenuOpen(false);
                setIsPartnersDialogOpen(true);
              }}
            >
              <div className="flex items-center gap-2">
                <UsersIcon className="size-4" />
                <span>Payment partners</span>
              </div>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onClick={handleLogout}>
            <div className="flex items-center gap-2 text-destructive">
              <LogOut className="size-4" />
              <span>Logout</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Hidden file input for avatar upload */}
      <input
        type="file"
        ref={fileInputRef}
        aria-label="Upload profile photo"
        className="hidden"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={handleFileChange}
      />

      {/* Payment Partners Dialog */}
      {user.bowlerId ? (
        <Dialog open={isPartnersDialogOpen} onOpenChange={setIsPartnersDialogOpen}>
          <DialogContent className="sm:max-w-120">
            <DialogHeader>
              <DialogTitle>Payment partners</DialogTitle>
            </DialogHeader>
            <div className="py-2">
              <BowlerPaymentLinksSection currentBowlerId={user.bowlerId} alwaysShow />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* Profile Dialog */}
      <Dialog open={isProfileDialogOpen} onOpenChange={setIsProfileDialogOpen}>
        <DialogContent className="sm:max-w-106.25">
          <DialogHeader>
            <DialogTitle>User Profile</DialogTitle>
          </DialogHeader>
          <div className="py-4 flex flex-col items-center gap-y-4">
            <Avatar size="lg" border="muted">
              {user.avatar ? (
                <AvatarImage src={user.avatar} alt={user.name || user.email} />
              ) : null}
              <AvatarFallback size="lg">{getInitials()}</AvatarFallback>
            </Avatar>
            <div className="text-center">
              <h3 className="font-medium text-lg">{user.name}</h3>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
            <div className="flex gap-4">
              <Button variant="outline" size="sm" onClick={triggerFileInput}>
                <Upload className="size-4 mr-2" />
                {isUploading ? "Uploading..." : "Change Avatar"}
              </Button>
            </div>
            <Separator />
            <div className="w-full space-y-2">
              <Label>Roles</Label>
              <div className="text-sm">
                {user.role === 'system_admin' && <div className="py-1">System Administrator</div>}
                {user.role === 'org_admin' && <div className="py-1">Organization Administrator</div>}
                {user.role === 'user' && <div className="py-1">Standard User</div>}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
