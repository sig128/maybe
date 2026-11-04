import { createBrowserRouter, createHashRouter } from "react-router";
import { Shell } from "./Shell.tsx";
import { Overview } from "../pages/Overview.tsx";
import { Discover, MarketPage } from "../pages/Discover.tsx";
import { Futures, NewFuture } from "../pages/Futures.tsx";
import { Builder } from "../pages/builder/Builder.tsx";
import { Review } from "../pages/Review.tsx";
import { StrategyDetail } from "../pages/StrategyDetail.tsx";
import { Money } from "../pages/Money.tsx";
import { Agents } from "../pages/Agents.tsx";
import { Rooms, RoomDetail } from "../pages/Rooms.tsx";
import { Activity } from "../pages/Activity.tsx";
import { NotFound, Ops, Settings } from "../pages/System.tsx";
import { RouteError } from "./RouteError.tsx";

// static hosts without SPA fallbacks (e.g. a hosted preview) build with VITE_HASH_ROUTER=1
const createRouter = import.meta.env.VITE_HASH_ROUTER === "1" ? createHashRouter : createBrowserRouter;

export const router = createRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Overview /> },
      { path: "discover", element: <Discover /> },
      { path: "markets/:key", element: <MarketPage /> },
      { path: "futures", element: <Futures /> },
      { path: "futures/new", element: <NewFuture /> },
      { path: "futures/:id", element: <StrategyDetail /> },
      { path: "futures/:id/edit", element: <Builder /> },
      { path: "futures/:id/review", element: <Review /> },
      { path: "money", element: <Money /> },
      { path: "agents", element: <Agents /> },
      { path: "rooms", element: <Rooms /> },
      { path: "rooms/:slug", element: <RoomDetail /> },
      { path: "activity", element: <Activity /> },
      { path: "ops", element: <Ops /> },
      { path: "settings", element: <Settings /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
