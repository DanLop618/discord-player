const ytdl = require('discord-ytdl-core')
const Discord = require('discord.js')
const ytsr = require('ytsr')

const Queue = require('./Queue')
const Track = require('./Track')

const filters = {
    bassboost: 'bass=g=20,dynaudnorm=f=200',
    '8D': 'apulsator=hz=0.128',
    vaporwave: 'asetrate=441000*.8,aresample=44100,atempo=1.1',
    nightcore: 'asetrate=441001*.25',
    phaser: 'aphaser=in_gain=0.4',
    tremolo: 'tremolo=f=6.5',
    reverse: 'areverse',
    treble: 'treble=g={GAIN}',
    normalizer: 'dynaudnorm=f=150',
    surrounding: 'surround',
    pulsator: 'apulsator=hz=1',
    subboost: 'asubboost'
}

/**
 * @typedef PlayerOptions
 * @property {boolean} [leaveOnEnd=true] Whether the bot should leave the current voice channel when the queue ends.
 * @property {boolean} [leaveOnStop=true] Whether the bot should leave the current voice channel when the stop() function is used.
 * @property {boolean} [leaveOnEmpty=true] Whether the bot should leave the voice channel if there is no more member in it.
 */

/**
 * Default options for the player
 * @ignore
 * @type {PlayerOptions}
 */
const defaultPlayerOptions = {
    leaveOnEnd: true,
    leaveOnStop: true,
    leaveOnEmpty: true
}

class Player {
    /**
     * @param {Discord.Client} client Discord.js client
     * @param {PlayerOptions} options Player options
     */
    constructor (client, options = {}) {
        if (!client) throw new SyntaxError('Invalid Discord client')

        /**
         * Discord.js client instance
         * @type {Discord.Client}
         */
        this.client = client
        /**
         * Player queues
         * @type {Queue[]}
         */
        this.queues = []
        /**
         * Player options
         * @type {PlayerOptions}
         */
        this.options = defaultPlayerOptions
        for (const prop in options) {
            this.options[prop] = options[prop]
        }

        // Listener to check if the channel is empty
        client.on('voiceStateUpdate', (oldState, newState) => this._handleVoiceStateUpdate(oldState, newState))
    }

    /**
     * Update the filters for the guild
     * @param {Discord.Snowflake} guildID
     * @param {Object} newFilters
     */
    updateFilters (guildID, newFilters) {
        return new Promise((resolve, reject) => {
            // Gets guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            Object.keys(newFilters).forEach((filterName) => {
                queue.filters[filterName] = newFilters[filterName]
            })
            this._playYTDLStream(queue, true, false)
        })
    }

    /**
     * Searchs tracks on YouTube
     * @param {string} query The query
     * @returns {Promise<Track[]>}
     */
    searchTracks (query) {
        return new Promise(async (resolve, reject) => {
            if (query.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)) {
                query = query.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)[1]
            }
            ytsr(query, (err, results) => {
                if (err) return []
                const resultsVideo = results.items.filter((i) => i.type === 'video')
                resolve(resultsVideo.map((r) => new Track(r, null, null)))
            })
        })
    }

    /**
     * Whether a guild is currently playing something
     * @param {Discord.Snowflake} guildID The guild ID to check
     * @returns {boolean} Whether the guild is currently playing tracks
     */
    isPlaying (guildID) {
        return this.queues.some((g) => g.guildID === guildID)
    }

    /**
     * Play a track in a voice channel
     * @param {Discord.VoiceChannel} voiceChannel The voice channel in which the track will be played
     * @param {Track|string} track The name of the track to play
     * @param {Discord.User?} user The user who requested the track
     * @returns {Promise<Track>} The played track
     */
    play (voiceChannel, track, user) {
        this.queues = this.queues.filter((g) => g.guildID !== voiceChannel.id)
        return new Promise(async (resolve, reject) => {
            if (!voiceChannel || typeof voiceChannel !== 'object') {
                return reject(new Error(`voiceChannel must be type of VoiceChannel. value=${voiceChannel}`))
            }
            const connection = voiceChannel.client.voice.connections.find((c) => c.channel.id === voiceChannel.id) || await voiceChannel.join()
            if (typeof track !== 'object') {
                const results = await this.searchTracks(track)
                track = results[0]
            }
            // Create a new guild with data
            const queue = new Queue(voiceChannel.guild.id)
            queue.voiceConnection = connection
            queue.filters = {}
            Object.keys(filters).forEach((f) => {
                queue.filters[f] = false
            })
            // Add the track to the queue
            track.requestedBy = user
            queue.tracks.push(track)
            // Add the queue to the list
            this.queues.push(queue)
            // Play the track
            this._playTrack(queue.guildID, true)
            // Resolve the track
            resolve(track)
        })
    }

    /**
     * Pause the current track
     * @param {Discord.Snowflake} guildID The ID of the guild where the current track should be paused
     * @returns {Promise<Track>} The paused track
     */
    pause (guildID) {
        return new Promise((resolve, reject) => {
            // Gets guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Pauses the dispatcher
            queue.voiceConnection.dispatcher.pause()
            queue.paused = true
            // Resolves the guild queue
            resolve(queue.tracks[0])
        })
    }

    /**
     * Resume the current track
     * @param {Discord.Snowflake} guildID The ID of the guild where the current track should be resumed
     * @returns {Promise<Track>} The resumed track
     */
    resume (guildID) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Pause the dispatcher
            queue.voiceConnection.dispatcher.resume()
            queue.paused = false
            // Resolve the guild queue
            resolve(queue.tracks[0])
        })
    }

    /**
     * Stops playing music.
     * @param {Discord.Snowflake} guildID The ID of the guild where the music should be stopped
     * @returns {Promise<void>}
     */
    stop (guildID) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Stop the dispatcher
            queue.stopped = true
            queue.tracks = []
            queue.voiceConnection.dispatcher.end()
            // Resolve
            resolve()
        })
    }

    /**
     * Update the volume
     * @param {Discord.Snowflake} guildID The ID of the guild where the music should be modified
     * @param {number} percent The new volume (0-100)
     * @returns {Promise<void>}
     */
    setVolume (guildID, percent) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Updates volume
            queue.voiceConnection.dispatcher.setVolumeLogarithmic(percent / 200)
            queue.volume = percent
            // Resolves guild queue
            resolve()
        })
    }

    /**
     * Get a guild queue
     * @param {Discord.Snowflake} guildID
     * @returns {?Queue}
     */
    getQueue (guildID) {
        // Gets guild queue
        const queue = this.queues.find((g) => g.guildID === guildID)
        return queue
    }

    /**
     * Add a track to the guild queue
     * @param {Discord.Snowflake} guildID The ID of the guild where the track should be added
     * @param {string} trackName The name of the track to add to the queue
     * @param {Discord.User?} requestedBy The user who requested the track
     * @returns {Promise<Track>} The added track
     */
    addToQueue (guildID, trackName, requestedBy) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Search the track
            this.search(trackName).then((track) => {
                if (!track[0]) return reject(new Error('Track not found'))
                track[0].requestedBy = requestedBy
                // Update queue
                queue.tracks.push(track[0])
                // Resolve the track
                resolve(track[0])
            }).catch(() => {
                return reject(new Error('Track not found'))
            })
        })
    }

    /**
     * Set the queue for a guild.
     * @param {Discord.Snowflake} guildID The ID of the guild where the queue should be set
     * @param {Track[]} tracks The tracks list
     * @returns {Promise<Queue>} The new queue
     */
    setQueue (guildID, tracks) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Update queue
            queue.tracks = tracks
            // Resolve the queue
            resolve(queue)
        })
    }

    /**
     * Clear the guild queue, but not the current track
     * @param {Discord.Snowflake} guildID The ID of the guild where the queue should be cleared
     * @returns {Promise<Queue>} The updated queue
     */
    clearQueue (guildID) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Clear queue
            const currentlyPlaying = queue.tracks.shift()
            queue.tracks = [currentlyPlaying]
            // Resolve guild queue
            resolve(queue)
        })
    }

    /**
     * Skip a track
     * @param {Discord.Snowflake} guildID The ID of the guild where the track should be skipped
     * @returns {Promise<Track>}
     */
    skip (guildID) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            const currentTrack = queue.tracks[0]
            // End the dispatcher
            queue.voiceConnection.dispatcher.end()
            queue.lastSkipped = true
            // Resolve the current track
            resolve(currentTrack)
        })
    }

    /**
     * Get the currently playing track
     * @param {Discord.Snowflake} guildID
     * @returns {Promise<Track>} The track which is currently played
     */
    nowPlaying (guildID) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            const currentTrack = queue.tracks[0]
            // Resolve the current track
            resolve(currentTrack)
        })
    }

    /**
     * Enable or disable the repeat mode
     * @param {Discord.Snowflake} guildID
     * @param {Boolean} enabled Whether the repeat mode should be enabled
     * @returns {Promise<Void>}
     */
    setRepeatMode (guildID, enabled) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Enable/Disable repeat mode
            queue.repeatMode = enabled
            // Resolve
            resolve()
        })
    }

    /**
     * Shuffle the guild queue (except the first track)
     * @param {Discord.Snowflake} guildID The ID of the guild where the queue should be shuffled
     * @returns {Promise<Queue>} The updated queue
     */
    shuffle (guildID) {
        return new Promise((resolve, reject) => {
            // Get guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Shuffle the queue (except the first track)
            const currentTrack = queue.tracks.shift()
            queue.tracks = queue.tracks.sort(() => Math.random() - 0.5)
            queue.tracks.unshift(currentTrack)
            // Resolve
            resolve(queue)
        })
    }

    /**
     * Remove a track from the queue
     * @param {Discord.Snowflake} guildID The ID of the guild where the track should be removed
     * @param {number|Track} track The index of the track to remove or the track to remove object
     * @returns {Promise<Track|null>}
     */
    remove (guildID, track) {
        return new Promise((resolve, reject) => {
            // Gets guild queue
            const queue = this.queues.find((g) => g.guildID === guildID)
            if (!queue) return reject(new Error('Not playing'))
            // Remove the track from the queue
            let trackFound = null
            if (typeof track === 'number') {
                trackFound = queue.tracks[track]
                if (trackFound) {
                    queue.tracks = queue.tracks.filter((t) => t !== trackFound)
                }
            } else {
                trackFound = queue.tracks.find((s) => s === track)
                if (trackFound) {
                    queue.tracks = queue.tracks.filter((s) => s !== trackFound)
                }
            }
            // Resolve
            resolve(trackFound)
        })
    }

    /**
     * Handle the voice state update event
     * @ignore
     * @private
     * @param {Discord.VoiceState} oldState
     * @param {Discord.VoiceState} newState
     */
    _handleVoiceStateUpdate (oldState, newState) {
        if (!this.options.leaveOnEmpty) return
        // If the member leaves a voice channel
        if (!oldState.channelID || newState.channelID) return
        // Search for a queue for this channel
        const queue = this.queues.find((g) => g.voiceConnection.channel.id === oldState.channelID)
        if (queue) {
            // If the channel is not empty
            if (queue.voiceConnection.channel.members.size > 1) return
            // Disconnect from the voice channel
            queue.voiceConnection.channel.leave()
            // Delete the queue
            this.queues = this.queues.filter((g) => g.guildID !== queue.guildID)
            // Emit end event
            queue.emit('channelEmpty')
        }
    }

    /**
     * Play a stream in a channel
     * @ignore
     * @private
     * @param {Queue} queue The queue to play
     * @param {*} updateFilter Whether this method is called to update some ffmpeg filters
     * @returns {Promise<void>}
     */
    _playYTDLStream (queue, updateFilter) {
        return new Promise((resolve) => {
            const currentStreamTime = updateFilter ? queue.voiceConnection.dispatcher.streamTime / 1000 : undefined
            const encoderArgsFilters = []
            Object.keys(queue.filters).forEach((filterName) => {
                if (queue.filters[filterName]) {
                    encoderArgsFilters.push(filters[filterName])
                }
            })
            let encoderArgs
            if (encoderArgsFilters.length < 1) {
                encoderArgs = []
            } else {
                encoderArgs = ['-af', encoderArgsFilters.join(',')]
            }
            const newStream = ytdl(queue.playing.url, {
                filter: 'audioonly',
                opusEncoded: true,
                encoderArgs,
                seek: currentStreamTime
            })
            setTimeout(() => {
                queue.voiceConnection.play(newStream, {
                    type: 'opus'
                })
                queue.voiceConnection.dispatcher.setVolumeLogarithmic(queue.volume / 200)
                // When the track starts
                queue.voiceConnection.dispatcher.on('start', () => {
                    resolve()
                })
                // When the track ends
                queue.voiceConnection.dispatcher.on('finish', () => {
                    // Play the next track
                    return this._playTrack(queue.guildID, false)
                })
            }, 1000)
        })
    }

    /**
     * Start playing a track in a guild
     * @ignore
     * @private
     * @param {Discord.Snowflake} guildID
     * @param {Boolean} firstPlay Whether the function was called from the play() one
     */
    async _playTrack (guildID, firstPlay) {
        // Get guild queue
        const queue = this.queues.find((g) => g.guildID === guildID)
        // If there isn't any music in the queue
        if (queue.tracks.length < 2 && !firstPlay && !queue.repeatMode) {
            // Leave the voice channel
            if (this.options.leaveOnEnd && !queue.stopped) queue.voiceConnection.channel.leave()
            // Remove the guild from the guilds list
            this.queues = this.queues.filter((g) => g.guildID !== guildID)
            // Emit stop event
            if (queue.stopped) {
                if (this.options.leaveOnStop) queue.voiceConnection.channel.leave()
                return queue.emit('stop')
            }
            // Emit end event
            return queue.emit('end')
        }
        const wasPlaying = queue.playing
        const nowPlaying = queue.playing = queue.repeatMode ? wasPlaying : queue.tracks.shift()
        // Reset lastSkipped state
        queue.lastSkipped = false
        this._playYTDLStream(queue, false).then(() => {
            // Emit trackChanged event
            if (!firstPlay) {
                queue.emit('trackChanged', nowPlaying, wasPlaying, queue.lastSkipped, queue.repeatMode)
            }
        })
    }
};

module.exports = Player
