export interface TweetResponse {
    type: string;
    id: string;
    url: string;
    twitterUrl: string;
    text: string;
    source: string;
    retweetCount: number;
    replyCount: number;
    likeCount: number;
    quoteCount: number;
    viewCount: number;
    createdAt: string;
    lang: string;
    bookmarkCount: number;
    isReply: boolean;
    inReplyToId: null;
    conversationId: string;
    inReplyToUserId: null;
    inReplyToUsername: null;
    isPinned: boolean;
    author: Author;
    extendedEntities: Url;
    card: Url;
    place: Url;
    entities: Url;
    isRetweet: boolean;
    isQuote: boolean;
    media: any[];
    isConversationControlled: boolean;
}

interface Author {
    type: string;
    userName: string;
    url: string;
    twitterUrl: string;
    id: string;
    name: string;
    isVerified: boolean;
    isBlueVerified: boolean;
    profilePicture: string;
    coverPicture: string;
    description: string;
    location: string;
    followers: number;
    following: number;
    status: string;
    canDm: boolean;
    canMediaTag: boolean;
    createdAt: string;
    entities: Entities;
    fastFollowersCount: number;
    favouritesCount: number;
    hasCustomTimelines: boolean;
    isTranslator: boolean;
    mediaCount: number;
    statusesCount: number;
    withheldInCountries: any[];
    affiliatesHighlightedLabel: Url;
    possiblySensitive: boolean;
    pinnedTweetIds: string[];
    profile_bio: Profilebio;
}

interface Profilebio {
    description: string;
    entities: Entities2;
}

interface Entities2 {
    description: Description2;
    url: Url3;
}

interface Url3 {
    urls: Url2[];
}

interface Url2 {
    display_url: string;
    expanded_url: string;
    indices: number[];
    url: string;
}

interface Description2 {
    user_mentions: Usermention[];
}

interface Usermention {
    id_str: string;
    indices: number[];
    name: string;
    screen_name: string;
}

interface Entities {
    description: Description;
    url: Url;
}

interface Url {}

interface Description {
    urls: any[];
}
