import type { TweetResponse } from '../interfaces/Output.js';
export function mapTweetResult(tweetResult: any): TweetResponse {
    const legacy = tweetResult.legacy ?? {};
    const details = tweetResult.details ?? {};
    const counts = tweetResult.counts ?? {};

    const userResult = tweetResult.core?.user_results?.result ?? {};
    const userCore = userResult.core ?? {};
    const userLegacy = userResult.legacy ?? {};
    const userId = userResult.rest_id;
    const tweetId = tweetResult.rest_id;

    const createdAt = details.created_at_ms ? new Date(Number(details.created_at_ms)).toISOString() : legacy.created_at;

    return {
        type: 'tweet',
        id: tweetId,
        url: `https://x.com/${userCore.screen_name}/status/${tweetId}`,
        twitterUrl: `https://twitter.com/${userCore.screen_name}/status/${tweetId}`,
        text: details.full_text ?? legacy.full_text,
        source: legacy.source ?? '',
        retweetCount: counts.retweet_count ?? legacy.retweet_count ?? 0,
        replyCount: counts.reply_count ?? legacy.reply_count ?? 0,
        likeCount: counts.favorite_count ?? legacy.favorite_count ?? 0,
        quoteCount: counts.quote_count ?? legacy.quote_count ?? 0,
        viewCount: tweetResult.views?.count ?? tweetResult.view_count_info?.count ?? null,
        createdAt,
        lang: legacy.lang,
        bookmarkCount: counts.bookmark_count ?? legacy.bookmark_count ?? 0,
        isReply: !!legacy.in_reply_to_status_id_str,
        inReplyToId: legacy.in_reply_to_status_id_str || null,
        conversationId: legacy.conversation_id_str,
        inReplyToUserId: legacy.in_reply_to_user_id_str || null,
        inReplyToUsername: legacy.in_reply_to_screen_name || null,
        isPinned: false,
        author: {
            type: 'user',
            userName: userCore.screen_name,
            url: `https://x.com/${userCore.screen_name}`,
            twitterUrl: `https://twitter.com/${userCore.screen_name}`,
            id: userId,
            name: userCore.name,
            isVerified: userResult.verification?.verified ?? false,
            isBlueVerified: userResult.verification?.is_blue_verified ?? userResult.is_blue_verified ?? false,
            profilePicture: userResult.avatar?.image_url,
            coverPicture: userLegacy.profile_banner_url ?? '',
            description: userResult.profile_bio?.description ?? userLegacy.description ?? '',
            location: userResult.location?.location ?? '',
            followers: userResult.relationship_counts?.followers ?? userLegacy.followers_count ?? 0,
            following: userResult.relationship_counts?.following ?? userLegacy.friends_count ?? 0,
            status: '',
            canDm: userResult.dm_permissions?.can_dm ?? false,
            canMediaTag: userResult.media_permissions?.can_media_tag ?? false,
            createdAt: userCore.created_at ?? '',
            entities: { description: { urls: [] }, url: {} },
            fastFollowersCount: userLegacy.fast_followers_count ?? 0,
            favouritesCount: userLegacy.favourites_count ?? 0,
            hasCustomTimelines: userLegacy.has_custom_timelines ?? true,
            isTranslator: userLegacy.is_translator ?? false,
            mediaCount: userLegacy.media_count ?? 0,
            statusesCount: userResult.tweet_counts?.tweets ?? userLegacy.statuses_count ?? 0,
            withheldInCountries: [],
            affiliatesHighlightedLabel: userResult.identity_profile_labels_highlighted_label ?? {},
            possiblySensitive: legacy.possibly_sensitive ?? false,
            pinnedTweetIds: [],
            profile_bio: {
                description: userResult.profile_bio?.description ?? userLegacy.description ?? '',
                entities: { description: { user_mentions: [] }, url: { urls: [] } },
            },
        },
        extendedEntities: {},
        card: {},
        place: {},
        entities: legacy.entities ?? {},
        isRetweet: !!legacy.retweeted_status_id_str,
        isQuote: !!legacy.quoted_status_id_str,
        media: tweetResult.media_entities2 ?? [],
        isConversationControlled: false,
    };
}
export function collectTweetsFromSearchTimelineResponse(
    fullJsonResponse: any,
    maxItems: number,
    collectedTweets: Map<string, any>,
): void {
    for (const response of fullJsonResponse) {
        // Dua bentuk respons: SearchByRawQuery memakai search_by_raw_query,
        // SearchTimeline memakai search_timeline. Versi sebelumnya hanya membaca
        // yang pertama, sehingga fallback SearchTimeline selalu menghasilkan 0 tweet.
        const instructions =
            response.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ??
            response.data?.search_timeline?.timeline?.instructions ??
            [];

        for (const instruction of instructions) {
            const instructionType = instruction.__typename || instruction.type;
            if (instructionType !== 'TimelineAddEntries') continue;

            for (const entry of instruction.entries || []) {
                if (collectedTweets.size >= maxItems) return;

                // Cek path baru (content.content) dan fallback ke path lama (content.itemContent)
                const rawResult =
                    entry.content?.content?.tweet_results?.result ?? entry.content?.itemContent?.tweet_results?.result;

                if (!rawResult) continue;

                // Kadang X membungkus tweet dengan wrapper TweetWithVisibilityResults
                const tweetResult = rawResult.__typename === 'TweetWithVisibilityResults' ? rawResult.tweet : rawResult;

                if (!tweetResult || tweetResult.__typename !== 'Tweet') continue;

                const tweetId = tweetResult.rest_id;
                if (!tweetId || collectedTweets.has(tweetId)) continue;

                collectedTweets.set(tweetId, mapTweetResult(tweetResult));
            }
        }
    }
}
