import * as React from 'react';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from '@/components/ui/navigation-menu';
import {
  LayoutDashboardIcon,
  ServerIcon,
  ScrollTextIcon,
  UsersIcon,
  CreditCardIcon,
  QrCodeIcon,
  MessageSquareIcon,
  SettingsIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleIcon,
} from 'lucide-react';

declare global {
  interface Window {
    setView?: (view: string, el?: HTMLElement | null) => void;
    setViewByName?: (view: string) => void;
  }
}

function navigateTo(view: string) {
  if (window.setViewByName) {
    window.setViewByName(view);
  } else if (window.setView) {
    window.setView(view);
  }
}

function NavLink({
  view,
  children,
  className,
}: {
  view: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href="#"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        navigateTo(view);
      }}
    >
      {children}
    </a>
  );
}

function ListItem({
  title,
  children,
  view,
  ...props
}: React.ComponentPropsWithoutRef<'li'> & { view: string }) {
  return (
    <li {...props}>
      <NavigationMenuLink asChild>
        <NavLink view={view}>
          <div className="text-sm leading-none font-medium">{title}</div>
          <p className="text-muted-foreground line-clamp-2 text-sm leading-snug">{children}</p>
        </NavLink>
      </NavigationMenuLink>
    </li>
  );
}

export default function AdminNav() {
  return (
    <NavigationMenu viewport={false}>
      <NavigationMenuList>
        {/* Мониторинг */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>Мониторинг</NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid gap-2 md:w-[400px] lg:w-[500px] lg:grid-cols-[.75fr_1fr]">
              <li className="row-span-3">
                <NavigationMenuLink asChild>
                  <NavLink
                    view="overview"
                    className="from-muted/50 to-muted flex h-full w-full flex-col justify-end rounded-md bg-linear-to-b p-6 no-underline outline-hidden select-none focus:shadow-md"
                  >
                    <ServerIcon className="size-6 opacity-70" />
                    <div className="mt-4 mb-2 text-lg font-medium">AI Server Hub</div>
                    <p className="text-muted-foreground text-sm leading-tight">
                      Панель управления локальным AI-сервером с мониторингом и аналитикой.
                    </p>
                  </NavLink>
                </NavigationMenuLink>
              </li>
              <ListItem view="overview" title="Обзор">
                Ключевые метрики сервера и активность за сегодня.
              </ListItem>
              <ListItem view="server" title="Сервер и AI">
                Состояние сервера и подключённых AI-моделей.
              </ListItem>
              <ListItem view="logs" title="Логи">
                События сервера в реальном времени.
              </ListItem>
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* Управление */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>Управление</NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[400px] gap-2 md:w-[500px] md:grid-cols-2 lg:w-[600px]">
              <ListItem view="users" title="Пользователи">
                Управление аккаунтами и уровнями доступа.
              </ListItem>
              <ListItem view="subs" title="Подписки">
                Тарифы, лимиты и биллинг пользователей.
              </ListItem>
              <ListItem view="qr" title="QR-доступ">
                Временный доступ к админке с мобильного через QR-код.
              </ListItem>
              <ListItem view="settings" title="Настройки">
                Параметры сервера, AI-провайдеров и почты.
              </ListItem>
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* AI Чат — прямая ссылка */}
        <NavigationMenuItem>
          <NavigationMenuLink asChild className={navigationMenuTriggerStyle()}>
            <NavLink view="chat">AI Чат</NavLink>
          </NavigationMenuLink>
        </NavigationMenuItem>

        {/* Быстрый доступ */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>Быстрый доступ</NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[200px] gap-4">
              <li>
                <NavigationMenuLink asChild>
                  <NavLink view="overview" className="flex-row items-center gap-2">
                    <LayoutDashboardIcon className="size-4" />
                    Обзор
                  </NavLink>
                </NavigationMenuLink>
                <NavigationMenuLink asChild>
                  <NavLink view="users" className="flex-row items-center gap-2">
                    <UsersIcon className="size-4" />
                    Пользователи
                  </NavLink>
                </NavigationMenuLink>
                <NavigationMenuLink asChild>
                  <NavLink view="settings" className="flex-row items-center gap-2">
                    <SettingsIcon className="size-4" />
                    Настройки
                  </NavLink>
                </NavigationMenuLink>
              </li>
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
