'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Key, Plus, Trash2, Loader2, Copy, Check, AlertTriangle, Pencil } from 'lucide-react';
import { ProtectedRoute } from '@/components/protected-route';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  listKeys,
  createKey,
  updateKey,
  deleteKey,
  type ApiKey,
  type CreateKeyResponse,
} from '@/services/keysService';

export default function ApiKeysPage() {
  const { isAuthenticated, loading: authLoading } = useAuth();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [featureDisabled, setFeatureDisabled] = useState(false);

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreateKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchKeys = useCallback(async () => {
    try {
      const data = await listKeys();
      setKeys(data);
      setFeatureDisabled(false);
    } catch (err: any) {
      if (err.message?.includes('501')) {
        setFeatureDisabled(true);
      } else {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load API keys. Please try again.',
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    fetchKeys();
  }, [isAuthenticated, authLoading, fetchKeys]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const result = await createKey(newKeyName.trim());
      setCreatedKey(result);
    } catch {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to create API key. Please try again.',
      });
      setCreating(false);
    }
  };

  const handleCreateDone = () => {
    setCreateOpen(false);
    setCreatedKey(null);
    setNewKeyName('');
    setCreating(false);
    setCopied(false);
    fetchKeys();
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const startRename = (key: ApiKey) => {
    setEditingId(key.id);
    setEditName(key.name);
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const handleRename = async (key: ApiKey) => {
    const trimmed = editName.trim();
    setEditingId(null);
    if (!trimmed || trimmed === key.name) return;
    // Optimistic update
    setKeys(prev => prev.map(k => (k.id === key.id ? { ...k, name: trimmed } : k)));
    try {
      await updateKey(key.id, { name: trimmed });
      toast({ title: 'Key renamed', description: `Key renamed to "${trimmed}".` });
    } catch {
      setKeys(prev => prev.map(k => (k.id === key.id ? { ...k, name: key.name } : k)));
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to rename key.' });
    }
  };

  const handleToggle = async (key: ApiKey) => {
    const newActive = !key.is_active;
    // Optimistic update
    setKeys(prev => prev.map(k => (k.id === key.id ? { ...k, is_active: newActive } : k)));
    try {
      await updateKey(key.id, { is_active: newActive });
      toast({
        title: newActive ? 'Key enabled' : 'Key disabled',
        description: `"${key.name}" has been ${newActive ? 'enabled' : 'disabled'}.`,
      });
    } catch {
      // Revert on error
      setKeys(prev => prev.map(k => (k.id === key.id ? { ...k, is_active: key.is_active } : k)));
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to update API key. Please try again.',
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteKey(deleteTarget.id);
      setKeys(prev => prev.filter(k => k.id !== deleteTarget.id));
      toast({
        title: 'Key deleted',
        description: `"${deleteTarget.name}" has been deleted.`,
      });
    } catch {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to delete API key. Please try again.',
      });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (featureDisabled) {
    return (
      <ProtectedRoute>
        <div className='container mx-auto px-4 py-6 max-w-7xl'>
          <div className='flex min-h-[60vh] items-center justify-center'>
            <div className='text-center space-y-4'>
              <AlertTriangle className='h-12 w-12 text-muted-foreground mx-auto' />
              <h2 className='text-xl font-semibold'>API Key Management Not Enabled</h2>
              <p className='text-muted-foreground max-w-md'>
                Configure <code className='text-sm bg-muted px-1.5 py-0.5 rounded'>AUTH_GATEWAY_URL</code> to
                enable this feature.
              </p>
            </div>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <div className='container mx-auto px-4 py-6 max-w-7xl'>
        {/* Header */}
        <div className='flex items-center justify-between mb-8'>
          <div>
            <h1 className='text-3xl font-bold'>API Keys</h1>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className='h-4 w-4 mr-2' />
            Create Key
          </Button>
        </div>

        {/* Content */}
        {loading ? (
          <div className='flex items-center justify-center py-20'>
            <Loader2 className='h-6 w-6 animate-spin' />
          </div>
        ) : keys.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-20 space-y-4'>
            <Key className='h-12 w-12 text-muted-foreground' />
            <p className='text-muted-foreground'>No API keys yet.</p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className='h-4 w-4 mr-2' />
              Create Key
            </Button>
          </div>
        ) : (
          <TooltipProvider>
            <div className='rounded-md border'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Key ID</TableHead>
                    <TableHead>Preview</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className='text-right'>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map(key => (
                    <TableRow key={key.id}>
                      <TableCell className='font-medium'>
                        {editingId === key.id ? (
                          <Input
                            ref={editInputRef}
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleRename(key);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            onBlur={() => handleRename(key)}
                            className='h-7 w-48'
                          />
                        ) : (
                          <span
                            className='cursor-pointer hover:underline inline-flex items-center gap-1.5 group'
                            onClick={() => startRename(key)}
                          >
                            {key.name}
                            <Pencil className='h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity' />
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={key.is_active ? 'default' : 'destructive'}>
                          {key.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className='font-mono text-sm truncate max-w-[120px] inline-block align-bottom'>
                              {key.kid}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className='font-mono text-xs'>{key.kid}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <span className='font-mono text-sm text-muted-foreground'>
                          ...{key.jwt_suffix}
                        </span>
                      </TableCell>
                      <TableCell className='text-muted-foreground'>
                        {formatDistanceToNow(new Date(key.created_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell>
                        <div className='flex items-center justify-end gap-3'>
                          <Switch
                            checked={key.is_active}
                            onCheckedChange={() => handleToggle(key)}
                          />
                          <Button
                            variant='ghost'
                            size='icon'
                            className='text-destructive hover:text-destructive'
                            onClick={() => setDeleteTarget(key)}
                          >
                            <Trash2 className='h-4 w-4' />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>
        )}
      </div>

      {/* Create key dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={open => {
          // Prevent closing while showing the token
          if (!open && createdKey) return;
          if (!open) {
            setNewKeyName('');
            setCreating(false);
          }
          setCreateOpen(open);
        }}
      >
        <DialogContent
          onPointerDownOutside={e => {
            if (createdKey) e.preventDefault();
          }}
          onEscapeKeyDown={e => {
            if (createdKey) e.preventDefault();
          }}
          // Hide the default close button when showing the token
          className={createdKey ? '[&>button]:hidden' : ''}
        >
          {!createdKey ? (
            <>
              <DialogHeader>
                <DialogTitle>Create API Key</DialogTitle>
                <DialogDescription>
                  Create a new API key for programmatic access.
                </DialogDescription>
              </DialogHeader>
              <div className='space-y-4 py-2'>
                <div className='space-y-2'>
                  <Label htmlFor='key-name'>Key name</Label>
                  <Input
                    id='key-name'
                    placeholder='e.g. production-backend'
                    value={newKeyName}
                    onChange={e => setNewKeyName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newKeyName.trim()) handleCreate();
                    }}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={!newKeyName.trim() || creating}>
                  {creating && <Loader2 className='h-4 w-4 mr-2 animate-spin' />}
                  Create
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>API Key Created</DialogTitle>
                <DialogDescription>
                  Copy this key now. You won&apos;t be able to see it again.
                </DialogDescription>
              </DialogHeader>
              <div className='space-y-4 py-2'>
                <div className='space-y-2'>
                  <Label>API Key</Label>
                  <Textarea
                    readOnly
                    value={createdKey.token}
                    className='font-mono text-xs h-24 resize-none'
                  />
                </div>
                <Button variant='outline' className='w-full' onClick={handleCopy}>
                  {copied ? (
                    <>
                      <Check className='h-4 w-4 mr-2' />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className='h-4 w-4 mr-2' />
                      Copy to clipboard
                    </>
                  )}
                </Button>
                <p className='text-sm text-amber-500 flex items-center gap-2'>
                  <AlertTriangle className='h-4 w-4 shrink-0' />
                  This is the only time the full key will be shown.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={handleCreateDone}>Done</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API Key</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? Clients using this
              key will lose access within ~5 minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
            >
              {deleting && <Loader2 className='h-4 w-4 mr-2 animate-spin' />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ProtectedRoute>
  );
}
