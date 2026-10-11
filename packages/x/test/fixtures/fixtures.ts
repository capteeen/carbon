/**
 * Hand-written fixtures shaped after the response schemas on docs.x.com
 * (read 2026-10-11). Not recorded from the live API: api.x.com is blocked
 * from the build sandbox. Test-only; never imported from src/.
 */
export const tokenResponse = {
  token_type: 'bearer',
  expires_in: 7200,
  access_token: 'FIXTURE-ACCESS-TOKEN-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  scope: 'tweet.read tweet.write users.read offline.access',
  refresh_token: 'FIXTURE-REFRESH-TOKEN-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

export const refreshedTokenResponse = {
  token_type: 'bearer',
  expires_in: 7200,
  access_token: 'FIXTURE-ACCESS-TOKEN-2-cccccccccccccccccccccccccccccc',
  scope: 'tweet.read tweet.write users.read offline.access',
  refresh_token: 'FIXTURE-REFRESH-TOKEN-2-ddddddddddddddddddddddddddddd',
};

export const invalidGrant = { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' };

export const usersMe = { data: { id: '1700000000000000001', name: 'Fixture Project', username: 'fixture_project' } };

export const createPost = (id: string, text: string) => ({ data: { id, text, edit_history_tweet_ids: [id] } });

export const searchRecent = {
  data: [
    {
      id: '1800000000000000001',
      text: 'fixture post one',
      author_id: '1600000000000000001',
      created_at: '2026-10-11T10:00:00.000Z',
      edit_history_tweet_ids: ['1800000000000000001'],
      public_metrics: { retweet_count: 3, reply_count: 1, like_count: 12, quote_count: 0, bookmark_count: 0, impression_count: 400 },
    },
    {
      id: '1800000000000000002',
      text: 'fixture post two',
      author_id: '1600000000000000002',
      created_at: '2026-10-11T10:01:00.000Z',
      edit_history_tweet_ids: ['1800000000000000002'],
    },
  ],
  meta: { newest_id: '1800000000000000002', oldest_id: '1800000000000000001', result_count: 2 },
};

export const mentions = {
  data: [
    {
      id: '1800000000000000010',
      text: '@fixture_project fixture mention',
      author_id: '1600000000000000003',
      created_at: '2026-10-11T11:00:00.000Z',
      edit_history_tweet_ids: ['1800000000000000010'],
      public_metrics: { retweet_count: 0, reply_count: 0, like_count: 1, quote_count: 0 },
    },
  ],
  meta: { result_count: 1, newest_id: '1800000000000000010', oldest_id: '1800000000000000010' },
};

export const trends = {
  data: [
    { trend_name: '#FixtureTrendA', tweet_count: 12000 },
    { trend_name: 'FixtureTrendB' },
  ],
};

export const forbiddenProblem = {
  title: 'Client Forbidden',
  detail: 'This request must be made using an approved developer account that is enrolled in the requested endpoint.',
  type: 'https://api.twitter.com/2/problems/client-forbidden',
  reason: 'client-not-enrolled',
  status: 403,
};

export const tooManyRequests = { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank', status: 429 };
