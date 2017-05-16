import express = require('express');
import crypto = require("crypto")
import path = require("path")
import fs = require("fs")
import gitfs = require('./gitfs')
import gmaps = require('./gmaps')
import mail = require('./mail')
import tools = require('./tools')
import auth = require('./auth')
import routing = require('./routing')
import expander = require('./expander')
import bluebird = require('bluebird')
import winston = require('winston')

export interface Translation {
    lang: string;
}

export interface WithTranslations {
    lang?: string;
    translations?: Translation[];
}

export interface EventTranslation extends Translation {
    title?: string;
    description?: string;
}

export interface CenterTranslation extends Translation {
    name?: string;
    program?: string;
    about?: string;
}

export interface EventIndexEntry extends Translation {
    id: number;
    startDate: string; // "2016-01-05"
    endDate: string;
    title: string;
    center: string; // "wroclaw"
    fullcity?: string;
    translations?: EventTranslation[];
}

export interface EventListEntry extends EventIndexEntry {
    weekdayRange?: string;
    dateRange?: string;
    combinedRange?: string;
}

export interface Address extends Translation {
    name: string;
    address: string; // multi-line
    fullcity?: string;
}

// address is optional - can be taken from center
export interface FullEvent extends EventListEntry, Address {
    startTime: string; // "20:00"
    description: string;
}

export interface EventIndex {
    events: EventIndexEntry[];
    nextId: number;
}

export interface Center extends Address {
    id: string;
    country: string;
    users: string[];
    program?: string;
    about?: string;
    translations?: CenterTranslation[];
}

let index: EventIndex
let currEventsPath = ""
let eventsCache: SMap<string> = {}

let hasAllCenters = false
let _centers: SMap<Center>

export function getLangs(ev: WithTranslations) {
    let langs = [ev.lang || "en"]
    if (ev.translations) {
        for (let t of ev.translations) {
            if (t.lang && langs.indexOf(t.lang) < 0)
                langs.push(t.lang)
        }
    }
    return langs
}

const writeAsync: (fn: string, v: Buffer | string) => Promise<void> = bluebird.promisify(fs.writeFile) as any

function forIndex(js: FullEvent): EventIndexEntry {
    return {
        id: js.id,
        startDate: js.startDate,
        endDate: js.endDate,
        title: js.title,
        center: js.center,
        lang: js.lang,
        translations: js.translations.map(t => ({
            lang: t.lang,
            title: t.title,
        }))
    }
}

function eventFn(id: number) {
    return ("000000" + id).slice(-6) + ".json"
}

const readdirAsync = bluebird.promisify(fs.readdir)
const readAsync: (fn: string, enc: string) => Promise<string> = bluebird.promisify(fs.readFile) as any

function cachedCenters() {
    if (!gitfs.events) {
        hasAllCenters = true
        return _centers = {}
    }
    if (_centers == null) {
        gitfs.events.onUpdate(isPull => {
            if (isPull) {
                _centers = {}
                hasAllCenters = false
            }
        })
        _centers = {}
    }
    return _centers
}

async function parseCenterAsync(str: string) {
    let c: Center = JSON.parse(str)
    if (!c.fullcity) {
        c.fullcity = (await gmaps.parseAddressAsync(c.address)).fullcity
    }
    return c
}

async function getCentersAsync() {
    let centers = cachedCenters()
    if (!hasAllCenters) {
        let dir = path.join(gitfs.config.eventsRepoPath, "centers")
        let files = await readdirAsync(dir)
        hasAllCenters = true
        for (let f of files) {
            let m = /^(\w+)\.json$/.exec(f)
            if (m) {
                if (!centers[m[1]]) {
                    let str = await readAsync(path.join(dir, f), "utf8")
                    centers[m[1]] = await parseCenterAsync(str)
                }
            }
        }
    }
    return centers
}

// TODO lock?
async function saveEventAsync(e: FullEvent, user: string) {
    eventsCache[e.id + ""] = JSON.stringify(e)

    let idx = index.events.findIndex(x => x.id == e.id)
    if (idx < 0) idx = index.events.length
    index.events.splice(idx, 1, forIndex(e))
    await writeAsync(path.join(currEventsPath, "index.json"), JSON.stringify(index, null, 1))

    await gitfs.events.setJsonFileAsync("current/" + eventFn(e.id), e, "Update " + e.title, user)
}

export async function readEventAsync(id: number): Promise<FullEvent> {
    if (!gitfs.events) {
        let c = await getCenterAsync("nowhere")
        return {
            id: 8,
            center: c.id,
            address: c.address,
            name: c.name,
            startDate: "2017-09-28",
            endDate: "",
            title: "Ngondro in Daily Life by Foo Bar",
            description: "<p>Start start start! something something!\n</p>\n<p>Second para 2</p>",
            startTime: "20:00",
            lang: "en"
        }
    }

    if (!index.events.some(e => e.id == id))
        return null
    let curr = eventsCache[id + ""]
    if (!curr) {
        let text = await gitfs.events.getTextFileAsync("current/" + eventFn(id))
        curr = eventsCache[id + ""] = text
    }
    let r: FullEvent = JSON.parse(curr)
    let c = await getCenterAsync(r.center)
    if (!r.address) {
        r.address = c.address
        r.name = c.name
    }
    r = augmentEvent(r) as FullEvent
    return r
}

function loadOrCreateIndex() {
    let idx = path.join(currEventsPath, "index.json")
    if (fs.existsSync(idx)) {
        index = readJson("index.json")
        return
    }

    winston.info("creating events index...")
    index = {
        events: [],
        nextId: 0
    }
    for (let fn of fs.readdirSync(currEventsPath)) {
        if (/^\d+\.json$/.test(fn)) {
            let js: FullEvent = readJson(fn)
            index.nextId = Math.max(index.nextId, js.id || 0)
            index.events.push(forIndex(js))
        }
    }
    index.nextId++
    fs.writeFileSync(idx, JSON.stringify(index, null, 1))

    function readJson(fn: string) {
        return JSON.parse(fs.readFileSync(path.join(currEventsPath, fn), "utf8"))
    }
}

function formatDate(d: Date) {
    return d.toISOString().slice(0, 10)
}

function validDate(d: string) {
    return d == null || d == "" || /^2\d\d\d-\d\d-\d\d$/.test(d)
}

function validTime(d: string) {
    return d == null || d == "" || /^\d\d:\d\d$/.test(d)
}

function validateLang(l: string) {
    if (typeof l != "string") return false
    return /^[a-z][a-z](-[A-Z]{2,3})?$/.test(l)
}

function getUpdateTarget(curr: WithTranslations, lang: string) {
    let trg = curr as any
    if (lang && lang != curr.lang) {
        if (!curr.translations) curr.translations = []
        trg = curr.translations.find(t => t.lang == lang)
        if (!trg) {
            curr.translations.push(trg = { lang: lang })
        }
    }
    return trg
}

function genericUpdate(curr: WithTranslations, delta: SMap<string>, lang: string, fields: string[]) {
    if (!validateLang(lang))
        return "invalid langauge code"

    let trg = getUpdateTarget(curr, lang)
    for (let k of fields) {
        let limit = 200
        if (k[0] == "*") {
            limit = 4000
            k = k.slice(1)
        }
        if (delta.hasOwnProperty(k)) {
            let v = delta[k] + ""
            if (v.length > limit)
                return k + " too long";
            trg[k] = v
        }
    }
    return ""
}

function applyCenterChanges(curr: Center, delta: Center, lang: string) {
    return genericUpdate(curr, delta as any, lang, [
        "*program",
        "*about",
        "name",
        "address",
    ])
}

function applyChanges(curr: FullEvent, delta: FullEvent, lang: string) {
    if (!validateLang(lang))
        return "invalid langauge code"

    if (curr.center && delta.center != curr.center)
        return "cannot change event center"
    if (!validDate(delta.startDate))
        return "invalid start date"
    if (!validDate(delta.endDate))
        return "invalid end date"
    if (!validTime(delta.startTime))
        return "invalid start time"

    for (let k of [
        "center",
        "startDate",
        "endDate",
        "startTime",
    ]) {
        if (delta.hasOwnProperty(k))
            (curr as any)[k] = (delta as any)[k]
    }

    return genericUpdate(curr, delta as any, lang, [
        "title",
        "*description",
        "name",
        "address",
    ])
}

function publicCenter(c: Center) {
    return {
        id: c.id,
        name: c.name,
        country: c.country,
        address: c.address,
    }
}

export async function getCenterAsync(id: string): Promise<Center> {
    if (!gitfs.events)
        return {
            id: "nowhere",
            name: "Diamond Way Center in Nowhere",
            address: "1600 Pennsylvania Ave NW<br>Washington, DC 20500",
            fullcity: "Washington, DC, US",
            country: "us",
            users: [],
            lang: "en"
        }
    if (typeof id != "string")
        return null
    let centers = cachedCenters()
    let r = tools.lookup(centers, id)
    if (r || hasAllCenters)
        return r
    let str = await gitfs.events.getTextFileAsync("centers/" + id + ".json")
    return (centers[id] = await parseCenterAsync(str))
}

function augmentEvent(ev: EventIndexEntry): EventListEntry {
    let r = tools.clone(ev) as EventListEntry

    let centers = cachedCenters()
    let c = centers[r.center]
    if (c)
        r.fullcity = c.fullcity

    r.weekdayRange = tools.weekDay(ev.startDate)
    r.dateRange = tools.monthPlusDay(ev.startDate)
    r.combinedRange = tools.fullDate(ev.startDate)
    if (r.endDate) {
        r.weekdayRange += "-" + tools.weekDay(ev.endDate)
        if (tools.monthName(ev.startDate) != tools.monthName(ev.endDate)) {
            r.dateRange += "-" + tools.monthPlusDay(ev.endDate)
        } else {
            r.dateRange += "-" + tools.monthDay(ev.endDate)
        }
        r.combinedRange += tools.fullDate(ev.endDate)
    }
    return r
}

async function queryEventsAsync(query: SMap<string>) {
    if (!gitfs.events) {
        return {
            totalCount: 2,
            events: [{
                id: 3,
                startDate: '2017-05-28',
                endDate: '',
                title: 'Introduction to Buddhism by D. W. Teacher',
                center: 'nowhere'
            },
            {
                id: 7,
                startDate: '2017-06-28',
                endDate: '',
                title: 'Seven Wisdoms',
                center: 'nowhere'
            }].map(augmentEvent)
        }
    }

    let startDate = query["start"] || formatDate(new Date(Date.now() - 3 * 24 * 3600 * 1000))
    let stopDate = query["stop"] || "9999-99-99"
    let center = query["center"] || "*"
    let country = query["country"] || "*"

    let events = index.events.filter(e => {
        let end = e.endDate || e.startDate
        if (end < startDate)
            return false
        if (e.startDate > stopDate)
            return false
        if (center != "*" && e.center != center)
            return false
        return true
    })

    // fetch centers for filtered events
    for (let e of events) {
        await getCenterAsync(e.center)
    }

    if (country != "*") {
        let centers = cachedCenters()
        events = events.filter(e => {
            let c = centers[e.center]
            if (!c || c.country != country)
                return false
            return true
        })
    }

    events.sort((a, b) =>
        tools.strcmp(a.startDate, b.startDate) || (a.id - b.id))
    let totalCount = events.length
    let skip = parseInt(query["skip"]) || 0
    if (skip)
        events = events.slice(skip)
    let count = Math.abs(parseInt(query["count"]) || 100)
    if (count > 100) count = 100
    if (events.length > count) events = events.slice(0, count)
    return {
        totalCount,
        events: events.map(augmentEvent),
    }
}

export async function expandEventListAsync(templ: string, query: SMap<string>) {
    let r = await queryEventsAsync(query)
    return tools.expandTemplateList(templ, r.events)
}

async function sendTemplateAsync(req: express.Request, cfg: expander.ExpansionConfig) {
    let res: express.Response = req._response

    cfg.ref = "master"
    cfg.appuser = req.appuser
    cfg.langs = req.langs

    let page = await expander.expandFileAsync(cfg)
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf8'
    })
    res.end(page.html)
}

export async function updateCenterAsync(id: string, f: (c: Center) => void, msg: string, user: string) {
    await gitfs.events.pokeAsync()
    let c = await getCenterAsync(id)
    f(c)
    await gitfs.events.setJsonFileAsync("centers/" + c.id + ".json", c, msg, user)
}

async function setMapImgAsync(
    pref: string,
    addrObj: (Address & WithTranslations),
    cfg: expander.ExpansionConfig
) {
    if (!cfg.contentOverride)
        cfg.contentOverride = {}

    let tr = (addrObj.translations || []).find(t => t.lang == cfg.lang) as any
    let base = addrObj as any

    for (let k of Object.keys(addrObj)) {
        let v = base[k]
        if (tr.hasOwnProperty(k)) v = tr[k]
        cfg.contentOverride[pref + k] = v + ""
    }

    let addr = gmaps.cleanAddress(addrObj.address)
    if (!cfg.vars) cfg.vars = {}
    cfg.vars[pref + "mapurl"] = "https://maps.google.com/?q=" + encodeURI(addr)
    cfg.vars[pref + "mapimg"] = await gmaps.getMapsPictureAsync({ address: addr })
}

export async function addVarsAsync(cfg: expander.ExpansionConfig) {
    if (cfg.centerInfo) {
        await setMapImgAsync("cnt_", cfg.centerInfo, cfg)
    }
    if (cfg.eventInfo) {
        await setMapImgAsync("ev_", cfg.eventInfo, cfg)
    }
}

async function addEventVarsCoreAsync(ev: FullEvent, cfg: expander.ExpansionConfig) {
    cfg.eventInfo = ev
}

export function initRoutes(app: express.Express) {
    if (!gitfs.events)
        return
    currEventsPath = path.join(gitfs.config.eventsRepoPath, "current")
    loadOrCreateIndex()

    winston.debug("mounting events")

    app.get("/events/:id/edit", async (req, res, next) => {
        let id = req.params["id"]
        let path = req.url.replace(/\/edit/, "")
        if (req.appuser) res.redirect(path)
        else res.redirect("/gw/login?redirect=" + encodeURIComponent(path))
    })

    app.get("/events/new", async (req, res, next) => {
        let ev: FullEvent
        if (!req.appuser)
            return res.redirect("/gw/login?redirect=" + encodeURIComponent(req.url))
        let isAdmin = await auth.hasWritePermAsync(req.appuser, [])
        let allCenters = tools.values(await getCentersAsync())
        let centers = allCenters
            .filter(c => isAdmin || (c.users || []).indexOf(req.appuser) >= 0)
        if (centers.length == 0) {
            res.status(402)
            routing.sendError(req, "User not setup",
                "Your user account is not setup to post in any center.")
            return
        }
        let c0 = centers[0]
        centers.sort((a, b) => tools.strcmp(a.id, b.id))
        if (req.query["center"]) {
            c0 = centers.find(c => c.id == req.query["center"])
            if (!c0)
                return res.status(402).end("Cannot post here")
        } else if (centers.length > 1) {
            let pref = req.url
            if (pref.indexOf("?") >= 0) pref += "&"
            else pref += "?"
            let body = centers.map(c =>
                `<li><a href="${pref + "center=" + c.id}">${c.id}</a>: ${c.name}`)
            routing.sendMsg(req, "Which center?",
                "<ul>" + body.join("\n") + "</ul>"
            )
            return
        }
        if (req.query["clone"]) {
            ev = await readEventAsync(parseInt(req.query["clone"]))
            if (!ev)
                return res.status(404).end("cannot clone")
            if (ev.center != c0.id) {
                ev.center = c0.id
                ev.address = c0.address
                ev.name = c0.name
            }
            ev.id = 0
        } else {
            ev = {
                id: 0,
                startDate: tools.formatDate(new Date(Date.now() + 14 * 24 * 3600 * 1000)),
                endDate: "",
                center: c0.id,
                name: c0.name,
                address: c0.address,
                startTime: "20:00",
                title: "Introduction to Buddhism by D. W. Teacher",
                description: "<p>Details coming up soon!</p>",
                lang: c0.lang,
            }
        }

        if (!tools.reqSetup(req)) return
        let cfg: expander.ExpansionConfig = {
            rootFile: "/events/_event.html",
            eventInfo: ev
        }
        await addVarsAsync(cfg)
        await sendTemplateAsync(req, cfg)
    })

    app.get("/api/events/:id", async (req, res, next) => {
        let id = parseInt(req.params["id"])
        let ev = await readEventAsync(id)
        if (!ev) {
            res.status(404).json({})
            return
        }
        res.json(ev)
    })

    app.get("/api/events", async (req, res, next) => {
        res.json(await queryEventsAsync(req.query))
    })

    app.post("/api/events", async (req, res, next) => {
        if (!req.appuser)
            return res.status(403).end()

        let delta = req.body as FullEvent
        let center = await getCenterAsync(delta.center)

        if (!center)
            return res.status(404).end()

        if (!await auth.hasWritePermAsync(req.appuser, center.users))
            return res.status(402).end()

        let currElt = { id: index.nextId } as FullEvent
        let isFresh = true
        if (typeof delta.id == "number") {
            if (delta.id <= 0) {
                delete delta.id
            } else {
                currElt = await readEventAsync(delta.id)
                if (!currElt)
                    return res.status(444).end()
                isFresh = false
            }
        }

        let err = applyChanges(currElt, delta, req.body["_lang"])
        if (err) {
            res.status(412).json({ error: err })
        } else {
            if (isFresh)
                index.nextId++
            if (currElt.endDate == currElt.startDate)
                delete currElt.endDate

            // TODO translations
            if (currElt.address == center.address)
                delete currElt.address
            if (currElt.name == center.name)
                delete currElt.name

            await saveEventAsync(currElt, req.appuser)
            res.json(currElt)
        }
    })

    app.get("/api/centers/:id", async (req, res, next) => {
        let c = await getCenterAsync(req.params["id"])
        if (!c)
            return res.status(404).end()
        if (req.appuser)
            res.json(c)
        else
            res.json(publicCenter(c))
    })

    app.get("/api/centers", async (req, res, next) => {
        let centers = await getCentersAsync()
        let lst = tools.values(centers)
        if (req.appuser)
            res.json({
                centers: lst
            })
        else
            res.json({
                centers: lst.map(publicCenter)
            })
    })

    app.post("/api/centers", async (req, res, next) => {
        if (!req.appuser)
            return res.status(403).end()

        let delta = req.body as Center
        let center = await getCenterAsync(delta.id)

        if (!center)
            return res.status(404).end()

        if (!await auth.hasWritePermAsync(req.appuser, center.users))
            return res.status(402).end()

        let lang = req.body["_lang"] as string

        let err = applyCenterChanges(center, delta, lang)
        if (err) {
            res.status(412).json({ error: err })
        } else {
            await updateCenterAsync(center.id, c => {
                applyCenterChanges(c, delta, lang)
                center = c
            }, "Center " + center.id + " updated", req.appuser)
            res.json(center)
        }
    })

}