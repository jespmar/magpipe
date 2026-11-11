/**
 * The Linear tracker (D38): Linear's GraphQL API with a personal API key, sent as the
 * `Authorization` header the way Linear's API documentation asks for personal keys. One request
 * per operation; the watcher's check is one query, paged only past 100 issues.
 */
import type { TrackerRef, TrackerTeam } from '../schemas';
import { TrackerError, type RemoteIssue, type Tracker, type TrackerState } from './types';

export const LINEAR_API = 'https://api.linear.app/graphql';

const ISSUE =
  'id identifier url title updatedAt state { id name type } parent { id } labels(first: 50) { nodes { name } }';

type GraphQLError = { message: string; extensions?: { type?: string; code?: string } };

export function linearTracker(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  endpoint = LINEAR_API,
): Tracker {
  async function call<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new TrackerError(`Linear could not be reached: ${(err as Error).message}`, 'network');
    }
    let body: { data?: T; errors?: GraphQLError[] } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // not JSON: fall through to the status code
    }
    const first = body.errors?.[0];
    const authFailed =
      res.status === 401 ||
      res.status === 403 ||
      /authenticat/i.test(first?.extensions?.type ?? first?.extensions?.code ?? '');
    if (authFailed) {
      throw new TrackerError(
        'Linear did not accept the API key. Check that it is a personal API key and not revoked.',
        'auth',
      );
    }
    if (first) throw new TrackerError(`Linear answered: ${first.message}`, 'invalid');
    if (!res.ok || !body.data) {
      throw new TrackerError(
        `Linear answered ${res.status}.`,
        res.status >= 500 ? 'network' : 'unknown',
      );
    }
    return body.data;
  }

  type RawIssue = Omit<RemoteIssue, 'parentId' | 'labels'> & {
    parent: { id: string } | null;
    labels?: { nodes: { name: string }[] } | null;
  };
  const shape = ({ parent, labels, ...rest }: RawIssue): RemoteIssue => ({
    ...rest,
    parentId: parent?.id ?? null,
    labels: labels?.nodes.map((l) => l.name) ?? [],
  });
  const issueOf = (raw: RawIssue | null | undefined, what: string): RemoteIssue => {
    if (!raw) throw new TrackerError(`Linear did not return the issue it ${what}.`, 'unknown');
    return shape(raw);
  };

  return {
    name: 'linear',

    async viewer(signal) {
      const data = await call<{ viewer: { name: string } }>(
        'query { viewer { name } }',
        {},
        signal,
      );
      return { name: data.viewer.name };
    },

    async teams(signal) {
      const data = await call<{ teams: { nodes: TrackerTeam[] } }>(
        'query { teams(first: 100) { nodes { id key name } } }',
        {},
        signal,
      );
      return data.teams.nodes;
    },

    async states(teamId, signal) {
      const data = await call<{
        team: { states: { nodes: (TrackerState & { position: number })[] } } | null;
      }>(
        'query ($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type position } } } }',
        { id: teamId },
        signal,
      );
      if (!data.team) throw new TrackerError('Linear has no such team.', 'not_found');
      return [...data.team.states.nodes]
        .sort((a, b) => a.position - b.position)
        .map(({ id, name, type }) => ({ id, name, type }));
    },

    async ensureLabel(teamId, name, signal) {
      const data = await call<{
        issueLabels: { nodes: (TrackerRef & { team: { id: string } | null })[] };
      }>(
        'query ($name: String!) { issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { id } } } }',
        { name },
        signal,
      );
      const found = data.issueLabels.nodes.find((l) => !l.team || l.team.id === teamId);
      if (found) return { id: found.id, name: found.name, created: false };
      const made = await call<{
        issueLabelCreate: { success: boolean; issueLabel: TrackerRef | null };
      }>(
        'mutation ($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }',
        { input: { name, teamId } },
        signal,
      );
      const label = made.issueLabelCreate.issueLabel;
      if (!made.issueLabelCreate.success || !label) {
        throw new TrackerError(`Linear did not create the label ${name}.`, 'unknown');
      }
      return { ...label, created: true };
    },

    async createIssue(input, signal) {
      const data = await call<{ issueCreate: { issue: RawIssue | null } }>(
        `mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`,
        { input },
        signal,
      );
      return issueOf(data.issueCreate.issue, 'created');
    },

    async setState(issueId, stateId, signal) {
      const data = await call<{ issueUpdate: { issue: RawIssue | null } }>(
        `mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } } }`,
        { id: issueId, input: { stateId } },
        signal,
      );
      return issueOf(data.issueUpdate.issue, 'updated');
    },

    async updateIssue(issueId, input, signal) {
      const data = await call<{ issueUpdate: { issue: RawIssue | null } }>(
        `mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } } }`,
        { id: issueId, input },
        signal,
      );
      return issueOf(data.issueUpdate.issue, 'updated');
    },

    async getIssue(issueId, signal) {
      const data = await call<{ issue: (RawIssue & { description: string | null }) | null }>(
        `query ($id: String!) { issue(id: $id) { ${ISSUE} description } }`,
        { id: issueId },
        signal,
      );
      if (!data.issue) throw new TrackerError('Linear has no such issue.', 'not_found');
      const { description, ...raw } = data.issue;
      return { ...shape(raw), description: description ?? '' };
    },

    async relate(blockingId, blockedId, signal) {
      await call(
        'mutation ($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }',
        { input: { issueId: blockingId, relatedIssueId: blockedId, type: 'blocks' } },
        signal,
      );
    },

    async comment(issueId, body, signal) {
      await call(
        'mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
        { input: { issueId, body } },
        signal,
      );
    },

    async issuesWithLabel({ teamId, labelId, since }, signal) {
      const out: RemoteIssue[] = [];
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data: {
          issues: {
            nodes: RawIssue[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } = await call(
          `query ($filter: IssueFilter, $after: String) { issues(first: 100, after: $after, filter: $filter) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`,
          {
            after,
            filter: {
              team: { id: { eq: teamId } },
              labels: { some: { id: { eq: labelId } } },
              ...(since ? { updatedAt: { gte: since.toISOString() } } : {}),
            },
          },
          signal,
        );
        out.push(...data.issues.nodes.map(shape));
        if (!data.issues.pageInfo.hasNextPage) break;
        after = data.issues.pageInfo.endCursor;
      }
      return out;
    },
  };
}
