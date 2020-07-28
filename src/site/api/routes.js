const constants = require("../../lib/constants")
const lang = require("../../lang")
const switcher = require("../../lib/utils/torswitcher")
const {fetchUser, getOrFetchShortcode, userRequestCache, history, assistantSwitcher} = require("../../lib/collectors")
const {render, redirect, getStaticURL} = require("pinski/plugins")
const {pugCache} = require("../passthrough")
const {getSettings} = require("./utils/getsettings")
const {getSettingsReferrer} = require("./utils/settingsreferrer")
const quota = require("../../lib/quota")

/** @param {import("../../lib/structures/TimelineEntry")} post */
function getPageTitle(post) {
	return (post.getCaptionIntroduction() || `Post from @${post.getBasicOwner().username}`) + " | Bibliogram"
}

module.exports = [
	{
		route: "/", methods: ["GET"], code: async ({req}) => {
			const settings = getSettings(req)
			return render(200, "pug/home.pug", {
				settings,
				settingsReferrer: getSettingsReferrer("/"),
				rssEnabled: constants.feeds.enabled,
				allUnblocked: history.testNoneBlocked() || assistantSwitcher.displaySomeUnblocked(),
				torAvailable: switcher.canUseTor(),
				hasPrivacyPolicy: constants.has_privacy_policy,
				onionLocation: constants.onion_location
			})
		}
	},
	{
		route: "/privacy", methods: ["GET"], code: async ({req}) => {
			const settings = getSettings(req)
			if (constants.has_privacy_policy && pugCache.has("pug/privacy.pug")) {
				return render(200, "pug/privacy.pug", {settings})
			} else {
				return render(404, "pug/friendlyerror.pug", {
					statusCode: 404,
					title: "No privacy policy",
					message: "No privacy policy",
					explanation:
						"The owner of this instance has not actually written a privacy policy."
						+"\nIf you own this instance, please read the file stored at /src/site/pug/privacy.pug.template.",
					settings
				})
			}
		}
	},
	{
		route: `/u`, methods: ["GET"], code: async ({url}) => {
			if (url.searchParams.has("u")) {
				let username = url.searchParams.get("u")
				username = username.replace(/^(https?:\/\/)?([a-z]+\.)?instagram\.com\//, "")
				username = username.replace(/^\@+/, "")
				username = username.replace(/\/+$/, "")
				username = username.toLowerCase()
				return redirect(`/u/${username}`, 301)
			} else {
				return render(400, "pug/friendlyerror.pug", {
					statusCode: 400,
					title: "Bad request",
					message: "Expected a username",
					explanation: "Write /u/{username} or /u?u={username}.",
					withInstancesLink: false
				})
			}
		}
	},
	{
		route: `/u/(${constants.external.username_regex})(/channel)?`, methods: ["GET"], code: async ({req, url, fill}) => {
			const username = fill[0]
			const type = fill[1] ? "igtv" : "timeline"

			if (username !== username.toLowerCase()) { // some capital letters
				return redirect(`/u/${username.toLowerCase()}`, 301)
			}

			const settings = getSettings(req)
			const params = url.searchParams

			try {
				if (quota.remaining(req) === 0) {
					throw constants.symbols.QUOTA_REACHED
				}

				const {user, quotaUsed} = await fetchUser(username)
				let remaining = quota.add(req, quotaUsed)

				const selectedTimeline = user[type]
				let pageNumber = +params.get("page")
				if (isNaN(pageNumber) || pageNumber < 1) pageNumber = 1
				const pageIndex = pageNumber - 1

				const pagesNeeded = pageNumber - selectedTimeline.pages.length
				if (pagesNeeded > remaining) {
					throw constants.symbols.QUOTA_REACHED
				}

				const quotaUsed2 = await selectedTimeline.fetchUpToPage(pageIndex)
				remaining = quota.add(req, quotaUsed2)

				const followerCountsAvailable = !(user.constructor.name === "ReelUser" && user.following === 0 && user.followedBy === 0)
				return render(200, "pug/user.pug", {
					url,
					user,
					selectedTimeline,
					type,
					followerCountsAvailable,
					constants,
					settings,
					settingsReferrer: getSettingsReferrer(req.url),
					remaining
				})
			} catch (error) {
				if (error === constants.symbols.NOT_FOUND || error === constants.symbols.ENDPOINT_OVERRIDDEN) {
					return render(404, "pug/friendlyerror.pug", {
						statusCode: 404,
						title: "Not found",
						message: "This user doesn't exist.",
						withInstancesLink: false,
						settings
					})
				} else if (error === constants.symbols.INSTAGRAM_DEMANDS_LOGIN) {
					return {
						statusCode: 503,
						contentType: "text/html",
						headers: {
							"Retry-After": userRequestCache.getTtl("user/"+username, 1000)
						},
						content: pugCache.get("pug/blocked.pug").web({
							website_origin: constants.website_origin,
							username,
							expiresMinutes: userRequestCache.getTtl("user/"+username, 1000*60),
							getStaticURL,
							settings,
							lang
						})
					}
				} else if (error === constants.symbols.RATE_LIMITED) {
					return render(503, "pug/blocked_graphql.pug")
				} else if (error === constants.symbols.extractor_results.AGE_RESTRICTED) {
					return render(403, "pug/age_gated.pug", {settings})
				} else if (error === constants.symbols.QUOTA_REACHED) {
					return render(429, "pug/friendlyerror.pug", {
						title: "Quota reached",
						statusCode: 429,
						message: "Quota reached",
						explanation:
							"Each person has a limited number of requests to Bibliogram."
							+"\nYou have reached that limit."
							+"\nWait a while to for your counter to reset.\n",
						withInstancesLink: true
					})
				} else {
					throw error
				}
			}
		}
	},
	{
		route: `/fragment/user/(${constants.external.username_regex})/(\\d+)`, methods: ["GET"], code: async ({req, url, fill}) => {
			const username = fill[0]
			let pageNumber = +fill[1]
			if (isNaN(pageNumber) || pageNumber < 1) {
				return {
					statusCode: 400,
					contentType: "text/html",
					content: "Bad page number"
				}
			}
			let type = url.searchParams.get("type")
			if (!["timeline", "igtv"].includes(type)) type = "timeline"

			try {
				if (quota.remaining(req) === 0) {
					throw constants.symbols.QUOTA_REACHED
				}

				const settings = getSettings(req)

				const {user, quotaUsed} = await fetchUser(username)
				const remaining = quota.add(req, quotaUsed)

				const pageIndex = pageNumber - 1
				const selectedTimeline = user[type]

				const pagesNeeded = pageNumber - selectedTimeline.pages.length
				if (pagesNeeded > remaining) {
					throw constants.symbols.QUOTA_REACHED
				}

				const quotaUsed2 = await selectedTimeline.fetchUpToPage(pageIndex)
				quota.add(req, quotaUsed2)

				if (selectedTimeline.pages[pageIndex]) {
					return render(200, "pug/fragments/timeline_page.pug", {page: selectedTimeline.pages[pageIndex], selectedTimeline, type, pageIndex, user, url, settings})
				} else {
					return {
						statusCode: 400,
						contentType: "text/html",
						content: "That page does not exist."
					}
				}
			} catch (error) {
				if (error === constants.symbols.NOT_FOUND || error === constants.symbols.ENDPOINT_OVERRIDDEN) {
					return render(404, "pug/friendlyerror.pug", {
						statusCode: 404,
						title: "Not found",
						message: "This user doesn't exist.",
						withInstancesLink: false
					})
				} else if (error === constants.symbols.INSTAGRAM_DEMANDS_LOGIN || error === constants.symbols.RATE_LIMITED) {
					return render(503, "pug/fragments/timeline_loading_blocked.pug")
				} else if (error === constants.symbols.QUOTA_REACHED) {
					return render(429, "pug/fragments/timeline_quota_reached.pug")
				} else {
					throw error
				}
			}
		}
	},
	{
		route: `/fragment/post/(${constants.external.shortcode_regex})`, methods: ["GET"], code: ({req, fill}) => {
			const shortcode = fill[0]
			return getOrFetchShortcode(shortcode).then(async post => {
				await post.fetchChildren()
				await post.fetchExtendedOwnerP() // serial await is okay since intermediate fetch result is cached
				if (post.isVideo()) await post.fetchVideoURL()
				const settings = getSettings(req)
				return {
					statusCode: 200,
					contentType: "application/json",
					content: {
						title: getPageTitle(post),
						html: pugCache.get("pug/fragments/post.pug").web({lang, post, settings, getStaticURL})
					}
				}
			}).catch(error => {
				if (error === constants.symbols.NOT_FOUND || constants.symbols.RATE_LIMITED) {
					return {
						statusCode: 503,
						contentType: "application/json",
						content: {
							redirectTo: `/p/${shortcode}`
						}
					}
				} else {
					throw error
				}
			})
		}
	},
	{
		route: "/p", methods: ["GET"], code: async ({url}) => {
			if (url.searchParams.has("p")) {
				let post = url.searchParams.get("p")
				post = post.replace(/^(https?:\/\/)?([a-z]+\.)?instagram\.com\/p\//, "")
				return redirect(`/p/${post}`, 301)
			} else {
				return render(400, "pug/friendlyerror.pug", {
					statusCode: 400,
					title: "Bad request",
					message: "Expected a shortcode",
					explanation: "Write /p/{shortcode} or /p?p={shortcode}.",
					withInstancesLink: false
				})
			}
		}
	},
	{
		route: `/p/(${constants.external.shortcode_regex})`, methods: ["GET"], code: ({req, fill}) => {
			const settings = getSettings(req)
			return getOrFetchShortcode(fill[0]).then(async post => {
				await post.fetchChildren()
				await post.fetchExtendedOwnerP() // serial await is okay since intermediate fetch result is cached
				if (post.isVideo()) await post.fetchVideoURL()
				return render(200, "pug/post.pug", {
					title: getPageTitle(post),
					post,
					website_origin: constants.website_origin,
					settings
				})
			}).catch(error => {
				if (error === constants.symbols.NOT_FOUND) {
					return render(404, "pug/friendlyerror.pug", {
						statusCode: 404,
						title: "Not found",
						message: "Somehow, you reached a post that doesn't exist.",
						withInstancesLink: false,
						settings
					})
				} else if (error === constants.symbols.RATE_LIMITED) {
					return render(503, "pug/blocked_graphql.pug")
				} else {
					throw error
				}
			})
		}
	}
]
