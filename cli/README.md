# speed

fast.com in your terminal, built on Bun. It talks directly to the same Netflix servers the website uses.

```sh
speed                # latency → download → upload, live
speed -s              # download only
speed history         # trend, table, fastest time of day
speed last --waybar   # bar module from the last result (no new test)
speed watch 30m --below 5   # log every 30 min, notify if under 5 Mbps
speed --json          # machine-readable
```

Build: `bun run build` (compiles a single binary to `dist/speed`, inside this folder). The bar widget uses it automatically when present.
History lives in `~/.local/share/fast-cli/history.db` (SQLite).

### How it measures
- **Download:** 8 parallel range requests spread across the servers fast.com hands out. The test stops once the 1s rate holds steady for 2s, or at the time cap. The ramp-up is excluded from the result.
- **Upload:** POSTs whose size adapts to the link. Bytes count only after the server acknowledges them, because counting at write time overstates upload (the kernel buffers megabytes instantly). Each request has a deadline, since these servers sometimes never answer.
- **Latency:** median of 10 tiny requests to the nearest server, measured idle and again while loaded. The gap between the two gives the bufferbloat grade.
