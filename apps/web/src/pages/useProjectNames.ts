import { useQuery } from '@tanstack/react-query';
import type { Project } from '@orc/shared';
import { useMemo } from 'react';
import { useApi } from '../api/ApiContext';
import { queryKeys } from '../api/queryKeys';
import { useCan } from '../auth/session';

/** First page (100) of projects for name lookups and selects; empty without project:read. */
export function useProjectOptions(status?: Project['status']) {
  const api = useApi();
  const can = useCan();
  const filters = { status: status ?? null, limit: 100 };
  return useQuery({
    queryKey: queryKeys.projectList(filters),
    queryFn: () => api.listProjects({ limit: 100, status }),
    enabled: can('project:read'),
    staleTime: 30_000,
  });
}

export function useProjectNames(): ReadonlyMap<string, string> {
  const projects = useProjectOptions().data;
  return useMemo(
    () => new Map((projects?.items ?? []).map((p) => [p.id, p.name] as const)),
    [projects],
  );
}
